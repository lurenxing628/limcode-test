const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const test = require('node:test');
const ts = require('typescript');

const action = name => items => items.find(item => item.action === name);
/** Values created inside the loaded module's context compare structurally only after a copy. */
const plain = value => JSON.parse(JSON.stringify(value));

function loadSource(relative, dependencies, globals = {}) {
  const filename = path.resolve(__dirname, '../..', relative);
  const module = { exports: {} };
  vm.runInNewContext(ts.transpileModule(fs.readFileSync(filename, 'utf8'), {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS }
  }).outputText, {
    module, exports: module.exports,
    require(name) {
      if (!Object.prototype.hasOwnProperty.call(dependencies, name)) throw new Error(`Unexpected source dependency: ${name}`);
      return dependencies[name];
    },
    ...globals
  }, { filename });
  return module.exports;
}

const compiled = process.env.LIMCODE_TEST_EXTENSION_ROOT
  ? path.resolve(process.env.LIMCODE_TEST_EXTENSION_ROOT) : path.resolve(__dirname, '../../dist/extension');
const largeMergeSession = require(path.join(compiled, 'backend/reliableKernel/runtimeLargeMergeSession.js'));

function emptyMergeReport(overrides = {}) {
  return { merged: [], deferred: [], blocked: [], failures: [], pendingSources: 0, stopped: false, ...overrides };
}

/** The window's open Runtime that receives online merges. */
const mergeHost = () => ({ product: { application: { database: { hostBootId: 'this-window' } } } });

function fixture({
  picks = [], confirmation, application, currentEpoch = 5, oldEpoch = 5,
  problems = [], upgradeError, informationChoice, changedAfterUpgrade = false,
  batchReport = { results: [], failures: [] }, batchHook, upgradeHook,
  mergeReport = emptyMergeReport(), mergeStates = {}, mergeError, mergeHook, exclusiveOutcome = 'completed', summaries = {}, globalState,
  emptyOld = false, lifetime = loadSource('vscode/runtimeDataSetUpgradeLifetime.ts', {}), largeWaiting = [], workspaceState
} = {}) {
  const current = { id: 'default', dataSetId: 'current', rootInstanceId: 'current-instance', runtimeKernelEpoch: currentEpoch, selected: true, runtimeDataRootPath: '/fixture/current', source: 'legacy' };
  const old = { id: 'workspace:old', ...(emptyOld ? {} : { dataSetId: 'old', rootInstanceId: 'old-instance' }), runtimeKernelEpoch: oldEpoch, selected: false, runtimeDataRootPath: '/fixture/old', source: 'workspace' };
  const calls = [];
  class SelectionRequired extends Error { constructor() { super('select'); this.candidates = [current, old]; this.problems = problems; } }
  const vscode = {
    window: {
      async showQuickPick(items) { const pick = picks.shift(); calls.push(['pick', items]); return typeof pick === 'function' ? pick(items) : pick === undefined ? undefined : items[pick]; },
      async showWarningMessage(message, options) { calls.push(['warning', message, options]); return Array.isArray(confirmation) ? confirmation.shift() : confirmation; },
      async showInformationMessage(message) { calls.push(['info', message]); return informationChoice; },
      async showErrorMessage(message) { calls.push(['error', message]); },
      async withProgress(_options, action) { return action(); },
      async showTextDocument(document) { calls.push(['document', document]); }
    },
    workspace: {
      registerTextDocumentContentProvider(_scheme, provider) { this.provider = provider; return { dispose() {} }; },
      onDidCloseTextDocument() { return { dispose() {} }; },
      async openTextDocument(uri) { return this.provider.provideTextDocumentContent(uri); }
    },
    Uri: { from(parts) { return { toString: () => JSON.stringify(parts) }; } },
    ProgressLocation: { Notification: 1 },
    commands: { async executeCommand(command) { calls.push(['command', command]); } }
  };
  const dependencies = {
    vscode,
    '../../backend/capabilities/vscodeStorage/globalStatus': { loadCommittedGlobalStatus: async () => {}, resolveDataRootUri: () => '/fixture' },
    '../../backend/capabilities/vscodeStorage/paths': { createVscodeStoragePaths: () => ({ globalStoragePath: '/fixture' }) },
    '../../backend/reliableKernel/vscodeRootAuthority': {
      inspectVscodeRuntimeDataSets: async () => ({ candidates: [current, old], problems }),
      resolveVscodeRuntimeDataSet: async (_paths, id) => {
        const candidate = id === current.id ? current : old;
        return changedAfterUpgrade ? { ...candidate, rootInstanceId: 'replaced-instance' } : candidate;
      },
      selectVscodeRuntimeDataSet: async (_paths, id) => calls.push(['select', id]),
      VscodeRuntimeDataSetSelectionRequiredError: SelectionRequired
    },
    '../../backend/reliableKernel/runtimeDataSetUpgrade': {
      upgradeDiscoveredRuntimeDataSets: async (_paths, options) => {
        calls.push(['auto-upgrade', options.excludeSelected, options.shouldContinue()]);
        if (batchHook) await batchHook(options);
        return batchReport;
      },
      upgradeRuntimeDataSet: async (_paths, input) => {
        calls.push(['upgrade', input.candidateId, input.expectedDataSetId, input.expectedRootInstanceId]);
        if (upgradeHook) await upgradeHook(input);
        if (upgradeError) throw upgradeError;
        const candidate = input.candidateId === current.id ? current : old;
        const previousEpoch = candidate.runtimeKernelEpoch;
        candidate.runtimeKernelEpoch = 5;
        return {
          candidateId: candidate.id,
          binding: { dataSetId: candidate.dataSetId, rootInstanceId: candidate.rootInstanceId },
          migrated: true, previousEpoch, backupPath: '/fixture/verified-upgrade-backup'
        };
      }
    },
    '../../backend/reliableKernel/runtimeDataSetMerge': {
      mergeHistoricalDataSetsOnline: async (_paths, target, options) => {
        calls.push(['merge-online', target.database.hostBootId, options.shouldContinue(), options.candidateIds ?? null]);
        if (mergeHook) {
          const hooked = await mergeHook(options);
          if (hooked) return hooked;
        }
        if (mergeError) throw mergeError;
        return mergeReport;
      },
      readRuntimeDataSetMergeStates: async () => new Map(Object.entries(mergeStates)),
      RUNTIME_DATA_SET_MERGE_AWAITING_EXCLUSIVE: 'runtime-data-set-merge-awaiting-exclusive',
      // Not the shipped values: the confirmation must say whatever the engine's bounds are.
      RUNTIME_DATA_SET_ONLINE_MERGE_LIMITS: { maxRows: 1234, maxBytes: 5 * 1024 * 1024 },
      RUNTIME_DATA_SET_MERGE_MAX_TRANSACTION_ROWS: 56789,
      RUNTIME_DATA_SET_STREAMED_MERGE_MAX_ROWS: 98765432,
      requestRuntimeDataSetMerge: async (_paths, input) => {
        calls.push(['merge-request', input.candidateId, input.expectedDataSetId, input.expectedRootInstanceId]);
      },
      // The library's admission and maintenance claim around a read of it.
      withRuntimeDataSetReadClaims: async (_paths, candidate, read) => {
        // As the engine: a library without data has no complete data set to claim.
        if (!candidate.dataSetId) throw new Error('这个历史库还没有数据。');
        calls.push(['claims', candidate.id]);
        try { return await read(); } finally { calls.push(['claims-released', candidate.id]); }
      }
    },
    '../../backend/reliableKernel/runtimeDataSetHistory': {
      // The history reader receives the located root; a local one keeps its candidate id.
      locateLocalRuntimeDataSet: async (_paths, id) => ({ id, origin: { kind: 'local', candidateId: id } }),
      openRuntimeDataSetHistory: async (_paths, root) => {
        calls.push(['history', root.id]);
        return {
          listConversations: async () => ({ items: [{ id: 'conversation', title: 'Original history', updatedAt: '2026-01-01' }] }),
          readMessages: async () => ({ items: [{ id: 'message', role: 'user', text: 'preserved text', createdAt: '2026-01-01' }] }),
          close: async () => calls.push(['close'])
        };
      }
    },
    '../../backend/reliableKernel/runtimeDataSetPreflight': {
      summarizeRuntimeDataSet: async candidate => {
        calls.push(['summarize', candidate.id]);
        if (summaries[candidate.id] instanceof Error) throw summaries[candidate.id];
        return summaries[candidate.id];
      }
    },
    '../../backend/reliableKernel/runtimeExclusiveMaintenance': { EXCLUSIVE_MAINTENANCE_DEFAULTS: { busyWaitTimeoutMs: 7 * 60_000 } },
    '../../backend/reliableKernel/runtimeStorageInspection': {
      deleteUnselectedRuntimeDataSet: async (_paths, id, expected) => calls.push(['delete', id, expected])
    },
    '../../backend/reliableKernel/runtimeContentUsage': { describeCurrentRuntimeContentUsage: async () => [] },
    './foreignRuntimeHistory': {
      manageForeignRuntimeHistory: async () => { calls.push(['foreign']); },
      announceForeignRuntimeHistoryOnStartup: async () => { calls.push(['foreign-announce']); }
    },
    '../../shared/extensionIdentity': { EXTENSION_COMMAND_IDS: { resetDevelopmentData: 'reset' } },
    '../runtimeDataSetUpgradeLifetime': lifetime,
    '../runtimeExclusiveMaintenance': {
      async runWithExclusiveMaintenance(paths, input, operation) {
        const { isCurrent, ...rest } = input;
        calls.push(['exclusive', paths.dataRootPath, rest, isCurrent()]);
        if (exclusiveOutcome !== 'completed') return { state: exclusiveOutcome, hosts: [], reason: '有 1 个窗口正在忙（有任务正在进行）' };
        return { state: 'completed', result: await operation(), coordinated: true };
      }
    },
    // The large merge session (大库会话): the adapter's cached waiting sources, its helpers, and its entry points.
    '../../backend/reliableKernel/runtimeLargeMergeEngine': {
      largeMergeEngine: () => ({
        waiting: async () => { calls.push(['large-waiting']); return largeWaiting; },
        noteBatch: (_paths, report) => { calls.push(['large-note', report]); }
      })
    },
    '../../backend/reliableKernel/runtimeLargeMergeSession': largeMergeSession,
    './largeHistoricalMerge': {
      LARGE_MERGE_SESSION_CAUSE: 'large-merge-session',
      isLargeHistoricalMergeHost: host => host?.large === true,
      async offerLargeHistoricalMerge(_context, _host, candidateIds, options) { calls.push(['large-offer', [...candidateIds], options]); },
      async startLargeHistoricalMerge(_context, _host, options) { calls.push(['large-start', options.candidateIds ? [...options.candidateIds] : null, options]); }
    }
  };
  const filename = path.resolve(__dirname, '../../vscode/commands/runtimeDataSetManagement.ts');
  const module = { exports: {} };
  // The module's log lines (the new context has no console of this process).
  const logs = [];
  const log = level => (...args) => logs.push([level, args.map(arg => arg instanceof Error ? arg.message : typeof arg === 'string' ? arg : JSON.stringify(arg)).join(' ')]);
  vm.runInNewContext(ts.transpileModule(fs.readFileSync(filename, 'utf8'), {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS }
  }).outputText, {
    module, exports: module.exports, require: name => dependencies[name] ?? require(name),
    console: { info: log('info'), warn: log('warn'), error: log('error'), log: log('log') }
  });
  return {
    ...module.exports, context: { subscriptions: [], ...(globalState ? { globalState } : {}), ...(workspaceState ? { workspaceState } : {}) },
    startup: { current: () => application }, calls, logs, SelectionRequired, lifetime
  };
}

test('startup asks once after selection-required, selects exact candidate and retries open', async () => {
  const f = fixture({ picks: [1] }); let opens = 0;
  assert.equal(await f.openWithRuntimeDataSetSelection(f.context, async () => {
    if (++opens === 1) throw new f.SelectionRequired();
    return 'ready';
  }), 'ready');
  assert.deepEqual(f.calls.filter(call => call[0] === 'select'), [['select', 'workspace:old']]);
  assert.equal(opens, 2);
});

test('cancelling startup picker never silently chooses a library', async () => {
  const f = fixture();
  await assert.rejects(f.openWithRuntimeDataSetSelection(f.context, async () => { throw new f.SelectionRequired(); }), /尚未选择/);
  assert.equal(f.calls.some(call => call[0] === 'select'), false);
});

test('deletion only offers other histories and cancellation performs no mutation', async () => {
  const f = fixture({ picks: [action('delete'), items => { assert.equal(items.length, 1); assert.equal(items[0].candidate.id, 'workspace:old'); return items[0]; }] });
  await f.manageRuntimeDataSets(f.context, f.startup);
  assert.equal(f.calls.some(call => call[0] === 'delete'), false);
  const confirmed = fixture({ picks: [action('delete'), 0], confirmation: '永久删除' });
  await confirmed.manageRuntimeDataSets(confirmed.context, confirmed.startup);
  assert.deepEqual(confirmed.calls.filter(call => call[0] === 'delete'), [['delete', 'workspace:old', 'old']]);
  assert.match(confirmed.calls.find(call => call[0] === 'warning')[2].detail, /还没有合并到当前库.*删除后其中的对话会永久丢失/,
    '复审 merge3 #7：没有账本记录、从未合并的待合并来源也要警告');
  assert.match(confirmed.calls.find(call => call[0] === 'warning')[2].detail, /归档.*会保留，之后作为外来历史库出现在“历史与存储管理 → 外来历史库”里，核验通过的可以只读查看/,
    '删除历史库不再连带删除归档，确认框写明');
});

test('历史与存储管理的“外来历史库”入口只打开外来历史库列表，不枚举也不改动本地库', async () => {
  const f = fixture({ picks: [action('foreign')] });
  await f.manageRuntimeDataSets(f.context, f.startup);
  const menu = f.calls.find(call => call[0] === 'pick');
  assert.ok(menu, '菜单已显示');
  assert.deepEqual(f.calls.filter(call => call[0] === 'foreign'), [['foreign']]);
  assert.equal(f.calls.some(call => ['history', 'delete', 'select', 'summarize'].includes(call[0])), false);
});

test('read-only history is available without runtime startup and closes its snapshot on exit', async () => {
  const f = fixture({ picks: [action('history'), 0, 0, 0, undefined] });
  await f.manageRuntimeDataSets(f.context, f.startup);
  assert.deepEqual(f.calls.filter(call => call[0] === 'history'), [['history', 'workspace:old']]);
  assert.equal(f.calls.filter(call => call[0] === 'close').length, 1);
  assert.match(f.calls.find(call => call[0] === 'document')[1], /preserved text/);
  assert.equal(f.calls.some(call => ['select', 'delete', 'command'].includes(call[0])), false);
});

test('switch uses live facade shutdown path, otherwise selects offline, then reloads', async () => {
  const live = [];
  const f = fixture({ picks: [action('select'), 1], confirmation: '切换并重载', application: { async selectRuntimeDataSet(id) { live.push(id); } } });
  await f.manageRuntimeDataSets(f.context, f.startup);
  assert.deepEqual(live, ['workspace:old']);
  assert.equal(f.calls.some(call => call[0] === 'select'), false);
  assert.deepEqual(f.calls.filter(call => call[0] === 'command'), [['command', 'workbench.action.reloadWindow']]);
  const offline = fixture({ picks: [action('select'), 1], confirmation: '切换并重载' });
  await offline.manageRuntimeDataSets(offline.context, offline.startup);
  assert.deepEqual(offline.calls.filter(call => ['select', 'command'].includes(call[0])), [['select', 'workspace:old'], ['command', 'workbench.action.reloadWindow']]);
});

const brokenSource = { id: 'workspace:broken', runtimeScopeRootPath: '/fixture/broken', message: '历史库缺少完整文件' };

test('an unavailable history displays its reason without blocking explicit selection of a healthy one', async () => {
  const f = fixture({
    problems: [brokenSource],
    picks: [items => items.find(item => item.problem), items => items.find(item => item.candidate?.id === 'workspace:old')]
  });
  let opens = 0;
  await f.openWithRuntimeDataSetSelection(f.context, async () => {
    if (++opens === 1) throw new f.SelectionRequired();
    return 'ready';
  });
  assert.equal(opens, 2);
  assert.match(f.calls.find(call => call[0] === 'error')[1], /历史库缺少完整文件/);
  assert.deepEqual(f.calls.filter(call => call[0] === 'select'), [['select', 'workspace:old']]);
});

test('unavailable old data is shown as an error, never as absence of history or permission to create an empty library', async () => {
  const f = fixture({ problems: [brokenSource], picks: [action('history'), items => items.find(item => item.problem), undefined] });
  await f.manageRuntimeDataSets(f.context, f.startup);
  assert.equal(f.calls.some(call => call[0] === 'error'), true);
  assert.equal(f.calls.some(call => ['upgrade', 'select', 'command', 'history'].includes(call[0])), false);
  assert.equal(f.calls.some(call => call[0] === 'info' && /尚无历史库/.test(call[1])), false);
});

for (const oldEpoch of [3, 4]) test(`epoch ${oldEpoch} history automatically backs up and upgrades without a user confirmation`, async () => {
  const f = fixture({
    oldEpoch, picks: [action('history'), 0, 0, 0, undefined]
  });
  await f.manageRuntimeDataSets(f.context, f.startup);
  assert.deepEqual(f.calls.filter(call => call[0] === 'upgrade'), [['upgrade', 'workspace:old', 'old', 'old-instance']]);
  assert.equal(f.calls.some(call => call[0] === 'warning'), false);
  assert.deepEqual(f.calls.filter(call => call[0] === 'history'), [['history', 'workspace:old']]);
  assert.match(f.calls.find(call => call[0] === 'document')[1], /preserved text/);
  assert.equal(f.calls.some(call => ['select', 'command', 'delete'].includes(call[0])), false);
});

test('closing the history picker does not trigger a history-read upgrade or switch', async () => {
  const f = fixture({ oldEpoch: 3, picks: [action('history'), undefined] });
  await f.manageRuntimeDataSets(f.context, f.startup);
  assert.equal(f.calls.some(call => ['upgrade', 'select', 'history', 'command'].includes(call[0])), false);
});

test('opening an old history completes upgrade before reading its messages', async () => {
  const f = fixture({ oldEpoch: 4, picks: [action('history'), 0, 0, 0, undefined] });
  await f.manageRuntimeDataSets(f.context, f.startup);
  const upgradeIndex = f.calls.findIndex(call => call[0] === 'upgrade');
  assert.ok(upgradeIndex >= 0 && upgradeIndex < f.calls.findIndex(call => call[0] === 'history'));
  assert.match(f.calls.find(call => call[0] === 'document')[1], /preserved text/);
  assert.equal(f.calls.some(call => ['select', 'command'].includes(call[0])), false);
});

test('migration failures retain the specific cause and never switch, reload or show an empty history', async () => {
  const cause = Object.assign(new Error('database backup could not be persisted'), { code: 'runtime-epoch-migration-backup-failed' });
  const f = fixture({ oldEpoch: 4, picks: [action('history'), 0], upgradeError: new Error('upgrade failed', { cause }) });
  await f.manageRuntimeDataSets(f.context, f.startup);
  const message = f.calls.find(call => call[0] === 'error')[1];
  assert.match(message, /runtime-epoch-migration-backup-failed/);
  assert.match(message, /没有自动重置/);
  assert.equal(f.calls.some(call => ['select', 'command', 'history'].includes(call[0])), false);
});

test('a changed data root after upgrade is not opened or reported as a failed migration', async () => {
  const f = fixture({ oldEpoch: 4, picks: [action('history'), 0], changedAfterUpgrade: true });
  await f.manageRuntimeDataSets(f.context, f.startup);
  const message = f.calls.find(call => call[0] === 'error')[1];
  assert.match(message, /升级已经完成/);
  assert.equal(f.calls.some(call => ['select', 'command', 'history'].includes(call[0])), false);
});

test('startup upgrades other old histories automatically without a confirmation or selection change', async () => {
  const f = fixture({ batchReport: { results: [{ backupPath: '/fixture/backup' }], failures: [] } });
  await f.upgradeHistoricalDataSetsOnStartup(f.context);
  assert.deepEqual(f.calls.filter(call => call[0] === 'auto-upgrade'), [['auto-upgrade', true, true]]);
  assert.equal(f.calls.some(call => ['pick', 'warning', 'select', 'command', 'history'].includes(call[0])), false);
});

test('obsolete activations admit no automatic upgrade and stop the next source after deactivation', async () => {
  const obsolete = fixture();
  await obsolete.upgradeHistoricalDataSetsOnStartup(obsolete.context, () => false);
  assert.equal(obsolete.calls.some(call => call[0] === 'auto-upgrade'), false);
  let active = true;
  const f = fixture({ batchHook(options) {
    assert.equal(options.shouldContinue(), true);
    active = false;
    assert.equal(options.shouldContinue(), false);
  } });
  await f.upgradeHistoricalDataSetsOnStartup(f.context, () => active);
  assert.equal(f.calls.some(call => ['select', 'command', 'warning'].includes(call[0])), false);
});

test('automatic upgrade reports a failed source without blocking current startup or asking permission', async () => {
  const f = fixture({ batchReport: {
    results: [{ backupPath: '/fixture/good-backup' }],
    failures: [{ candidateId: 'workspace:busy', stage: 'upgrade', code: 'runtime-host-live', message: '旧库正在使用' }]
  } });
  await f.upgradeHistoricalDataSetsOnStartup(f.context);
  assert.match(f.calls.find(call => call[0] === 'warning')[1], /暂时无法自动升级/);
  assert.equal(f.calls.some(call => ['pick', 'select', 'command', 'history'].includes(call[0])), false);
});

function deferred() {
  let resolve;
  const promise = new Promise(done => { resolve = done; });
  return { promise, resolve };
}

/** Run the actual activation and management modules with a controllable Runtime/upgrade boundary. */

/** A window whose open Runtime can run the large merge session (the Facade has the data-directory methods). */
const largeHost = () => ({ ...mergeHost(), large: true, dataRootPath: () => '/fixture' });
const AWAITING = 'runtime-data-set-merge-awaiting-exclusive';

test('大库会话：批结果里等大库会话的来源（引擎连同批里超过在线上限的中等来源一起记为等待）不当成“暂时无法合并”提示；启动后交给会话提示，并记下各自的规模；用户点击的合并直接进入会话的确认', async () => {
  const report = emptyMergeReport({
    deferred: [
      { candidateId: 'workspace:huge', code: AWAITING, message: '较大，等待合并', newly: true, size: { rows: 700_000, bytes: 180 * 1024 * 1024 } },
      { candidateId: 'workspace:medium', code: AWAITING, message: '较大，等待合并', newly: true, size: { rows: 5_000, bytes: 2 * 1024 * 1024 } },
      { candidateId: 'workspace:busy', code: 'runtime-hosts-active', message: '正被旧窗口使用', newly: true }
    ]
  });
  const f = fixture({ mergeReport: report });
  const returned = await f.mergeHistoricalDataSetsInBackground(f.context, largeHost());
  assert.equal(returned, report);
  // The adapter keeps which sources wait now (the management menu and list read it), before the session starts.
  const noted = f.calls.findIndex(call => call[0] === 'large-note');
  assert.ok(noted >= 0 && noted < f.calls.findIndex(call => call[0] === 'large-offer'));
  assert.equal(f.calls[noted][1], report);
  const notices = f.calls.filter(call => ['warning', 'info'].includes(call[0])).map(call => call[1]);
  assert.deepEqual(notices, ['有 1 份旧聊天记录暂时无法合并（正被旧窗口使用），以后启动时会自动重试。']);
  assert.deepEqual(f.calls.filter(call => call[0] === 'large-offer').map(call => call[1]), [['workspace:huge', 'workspace:medium']]);
  assert.equal(f.calls.some(call => call[0] === 'large-start'), false);
  // The session tells its outcomes through the same notices and dedup.
  const options = f.calls.find(call => call[0] === 'large-offer')[2];
  assert.equal(typeof options.report, 'function');
  assert.equal(typeof options.freshCause, 'function');
  // A window without the data-directory methods (e.g. a test double) offers nothing.
  const plainHost = fixture({ mergeReport: report });
  await plainHost.mergeHistoricalDataSetsInBackground(plainHost.context, mergeHost());
  assert.equal(plainHost.calls.some(call => call[0] === 'large-offer'), false);
  // The user's click: straight to the session's confirmation, for the sources it asked for.
  const requested = fixture({ mergeReport: emptyMergeReport({ deferred: [{ candidateId: 'workspace:huge', code: AWAITING, message: '较大，等待合并', newly: true, requested: true }] }) });
  await requested.mergeHistoricalDataSetsInBackground(requested.context, largeHost(), () => true, ['workspace:huge']);
  assert.deepEqual(requested.calls.filter(call => call[0] === 'large-start').map(call => call[1]), [['workspace:huge']]);
  assert.equal(requested.calls.some(call => ['warning', 'info'].includes(call[0])), false, 'not told as deferred or as “nothing was done”');
});

test('大库会话：中等来源随大库会话一起等由引擎在批里判断（记为等待大库会话，不再调用协调）；这里不另外拦截：引擎请求协调的来源（没有大库的批、用户点击的）照常协调，也不查等待列表', async () => {
  const withLocks = body => body();
  const oversized = requested => ({
    targetPaths: { dataRootPath: '/fixture/current' }, requesterHostBootId: 'this-window',
    candidateId: 'workspace:medium', operationKey: 'workspace:medium@0123', requested, withLocks, isDeterministicFailure: () => false
  });
  const waiting = [{ candidateId: 'workspace:huge', rows: 700_000, bytes: 180 * 1024 * 1024 }];
  for (const requested of [false, true]) {
    const f = fixture({ largeWaiting: waiting, mergeHook: async options => {
      await options.coordinateOversized(oversized(requested), async () => {});
    } });
    await f.mergeHistoricalDataSetsInBackground(f.context, largeHost(), () => true, requested ? ['workspace:medium'] : undefined);
    assert.equal(f.calls.filter(call => call[0] === 'exclusive').length, 1, requested ? 'the click' : 'a batch without a large source');
    assert.equal(f.calls.some(call => call[0] === 'large-waiting'), false, 'the batch alone decides what goes along with the session');
  }
});

test('大库会话：“历史与存储管理”只在有来源等待时列出“合并较大的旧聊天记录（N 份，约 X 条记录，准备后给出预计时长）”，合并列表里把它们标为“较大，等待合并（约 X 条记录，准备后给出预计时长）”——准备之前不编时长；入口开始手动合并，运行时没打开时说明', async () => {
  const waiting = [
    { candidateId: 'workspace:old', rows: 700_000, bytes: 180 * 1024 * 1024 },
    { candidateId: 'workspace:other', rows: 50_000, bytes: 12 * 1024 * 1024 }
  ];
  const none = fixture({ picks: [undefined] });
  await none.manageRuntimeDataSets(none.context, none.startup);
  assert.equal(none.calls[0][0], 'large-waiting');
  assert.equal(none.calls.find(call => call[0] === 'pick')[1].some(item => item.action === 'largeMerge'), false);
  const listed = fixture({ largeWaiting: waiting, picks: [action('merge'), undefined] });
  await listed.manageRuntimeDataSets(listed.context, listed.startup);
  const [menu, sources] = listed.calls.filter(call => call[0] === 'pick').map(call => call[1]);
  const entry = menu.find(item => item.action === 'largeMerge');
  assert.equal(entry.label, '合并较大的旧聊天记录（2 份，约 75 万条记录，准备后给出预计时长）');
  assert.equal(menu.indexOf(entry), menu.findIndex(item => item.action === 'merge') + 1);
  assert.equal(sources[0].label, '其他历史库 · 旧工作区历史 · 较大，等待合并（约 70 万条记录，准备后给出预计时长）');
  assert.ok(!JSON.stringify(menu).includes('分钟）'), 'no duration before preparing');
  const offline = fixture({ largeWaiting: waiting, picks: [action('largeMerge')] });
  await offline.manageRuntimeDataSets(offline.context, offline.startup);
  assert.deepEqual(offline.calls.filter(call => call[0] === 'error').map(call => call[1]), ['运行时没有打开，不能合并较大的旧聊天记录。']);
  const running = fixture({ largeWaiting: waiting, picks: [action('largeMerge')], application: largeHost() });
  await running.manageRuntimeDataSets(running.context, running.startup);
  const [start] = running.calls.filter(call => call[0] === 'large-start');
  assert.equal(start[1], null, 'the session takes the waiting sources itself');
  assert.equal(typeof start[2].report, 'function');
});

test('大库会话：重载后按在线合并的同一套通知与去重说明结果（合并的对话数可查看每一份的详情；点了取消的那一份总会说明）；合并中途出错也说明；只提示一次', async () => {
  const values = new Map();
  const workspaceState = { get: key => values.get(key), update: async (key, value) => { if (value === undefined) values.delete(key); else values.set(key, value); } };
  const merged = { candidateId: 'workspace:huge', insertedRows: 700_000, insertedConversations: 321, backupPath: '/fixture/backup', exclusive: true };
  await largeMergeSession.keepLargeMergeResult(workspaceState, {
    configurationRootPath: '/fixture', requested: false, details: ['workspace:huge（/fixture/huge，约 70 万条记录）：新增 321 个对话。'],
    report: emptyMergeReport({ merged: [merged], deferred: [{ candidateId: 'workspace:other', code: 'runtime-data-set-merge-large-session-cancelled', message: '合并时取消了，这一份已撤回。', newly: true, requested: true }] })
  });
  const f = fixture({ workspaceState, informationChoice: '查看详情' });
  await f.reportLargeHistoricalMergeKeptAcrossReload(f.context, () => true, Date.now());
  await new Promise(resolve => setImmediate(resolve));
  const infos = f.calls.filter(call => call[0] === 'info').map(call => call[1]);
  assert.deepEqual(infos, [
    '已把 1 份较大的旧聊天记录合并到当前历史库（新增 321 个对话），可直接在侧栏继续。原库和合并前备份都已保留。',
    '有 1 份旧聊天记录暂时无法合并（合并时取消了，这一份已撤回），以后启动时会自动重试。'
  ]);
  assert.match(f.calls.find(call => call[0] === 'document')[1], /workspace:huge（\/fixture\/huge，约 70 万条记录）：新增 321 个对话。/);
  await f.reportLargeHistoricalMergeKeptAcrossReload(f.context, () => true, Date.now());
  assert.equal(f.calls.filter(call => call[0] === 'info').length, 2, 'told once');
  await largeMergeSession.keepLargeMergeResult(workspaceState, { configurationRootPath: '/fixture', requested: true, details: [], error: '写入失败。已经合并完的会保留，其余的以后启动时会再合并' });
  const failed = fixture({ workspaceState });
  await failed.reportLargeHistoricalMergeKeptAcrossReload(failed.context, () => true, Date.now());
  assert.deepEqual(failed.calls.filter(call => call[0] === 'warning').map(call => call[1]), ['合并较大的旧聊天记录时出错：写入失败。已经合并完的会保留，其余的以后启动时会再合并。']);
  // The engine's own check at the session's start found too little room: said once, as such (not one failure per source).
  await largeMergeSession.keepLargeMergeResult(workspaceState, {
    configurationRootPath: '/fixture', requested: false, details: [], notStarted: '磁盘空间不足，需要约 120 MB：合并较大的旧聊天记录要在 /fixture/current 暂存数据'
  });
  const short = fixture({ workspaceState });
  await short.reportLargeHistoricalMergeKeptAcrossReload(short.context, () => true, Date.now());
  assert.deepEqual(short.calls.filter(call => ['warning', 'info'].includes(call[0])).map(call => call[1]), [
    '合并较大的旧聊天记录没有进行：磁盘空间不足，需要约 120 MB：合并较大的旧聊天记录要在 /fixture/current 暂存数据。当前历史库没有改动；腾出空间后，下次启动时会再提示，也可以在“历史与存储管理”里手动开始。'
  ]);
});

function extensionEntryFixture({ onDemand = false, upgradeError, mergeHook, keptNotice } = {}) {
  const events = [];
  const openOptions = [];
  const participantOptions = [];
  const opening = deferred();
  const opened = deferred();
  const upgradeStarted = deferred();
  const finishUpgrade = deferred();
  let startup;
  const application = {
    ...mergeHost(),
    async dispose() { events.push('dispose'); },
    async startRuntimeRecovery() { events.push('recover'); },
    dataRootPath() { return '/fixture/data-root'; },
    postToWebview(clientId, message) { events.push(['post-to-webview', clientId, message.type]); return true; }
  };
  const lifetime = loadSource('vscode/runtimeDataSetUpgradeLifetime.ts', {});
  const management = fixture({ lifetime, upgradeError, mergeHook,
    ...(onDemand ? { oldEpoch: 4, picks: [action('history'), 0] } : {}),
    upgradeHook: async () => {
      events.push('upgrade-start');
      upgradeStarted.resolve();
      await finishUpgrade.promise;
      events.push('upgrade-finished');
    },
    batchHook: async options => {
      events.push('upgrade-start');
      assert.equal(startup.current(), application);
      upgradeStarted.resolve(options);
      await finishUpgrade.promise;
      events.push('upgrade-finished');
      if (options.shouldContinue()) events.push('next-source');
    }
  });
  const extension = loadSource('vscode/extension.ts', {
    vscode: { window: {
      async showErrorMessage(message) { events.push(['error', message]); },
      async showWarningMessage(message) { events.push(['warning-message', message]); }
    } },
    './commands/registerCommands': { registerCommands(_context, barrier) { startup = barrier; } },
    './panels/MainPanel': { MainPanel: {
      registerSerializer() {},
      saveComposerDrafts(post) {
        events.push('save-drafts');
        return post('panel-client', { type: 'composer.draft.save' }) ? 1 : 0;
      }
    } },
    './views/SidebarEntryView': { registerSidebarEntryView() {} },
    './ApplicationStartup': loadSource('vscode/ApplicationStartup.ts', {}),
    './runtimeDataSetUpgradeLifetime': lifetime,
    '../shared/extensionIdentity': { EXTENSION_BRAND: 'Fixture' },
    '../backend/application/reliableKernel/VscodeReliableKernelApplicationFacade': {
      VscodeReliableKernelApplicationFacade: { open(_context, options) {
        events.push('open');
        openOptions.push(options);
        opening.resolve();
        return opened.promise;
      } }
    },
    './commands/runtimeDataSetManagement': management,
    // No data-directory move in progress: nothing to wait for or finish.
    './commands/dataRootRelocation': { async beforeDataRootOpen() { return undefined; }, async afterDataRootOpened() {} },
    // The real presenter: its notification is recorded.
    './runtimeOpeningWait': loadSource('vscode/runtimeOpeningWait.ts', { vscode: {
      ProgressLocation: { Notification: 15 },
      window: {
        async withProgress(options, task) {
          events.push(['opening-notification', options.title]);
          await task({ report() {} });
          events.push(['opening-notification-closed']);
        }
      }
    } }),
    './watchers/GlobalSettingsWatcher': { registerGlobalSettingsWatcher() {} },
    './runtimeExclusiveMaintenance': {
      startExclusiveMaintenanceParticipant(host, options) {
        events.push(['participant-start', host === application, options.isCurrent()]);
        participantOptions.push(options);
        return {
          async dispose() { events.push('participant-dispose'); },
          async unregister() { events.push('participant-unregister'); }
        };
      },
      takeNoticeKeptAcrossReload(_state, openedAt) {
        events.push(['kept-notice-read', openedAt]);
        return keptNotice;
      }
    },
    '../backend/application/runtimeBuildInfo': { RUNTIME_BUILD_INFO: {} }
  }, {
    setImmediate,
    console: { log() {}, warn(...args) { events.push(['warning', ...args]); }, error(...args) { events.push(['error', ...args]); } }
  });
  // Nothing kept across a reload in these activations.
  management.context.workspaceState = { get() { return undefined; }, async update() {} };
  return {
    ...extension, application, context: management.context, calls: management.calls, events, management, lifetime, openOptions, participantOptions,
    opening, opened, upgradeStarted, finishUpgrade,
    get startup() { return startup; }
  };
}

test('extension starts automatic historical upgrades only after Runtime ready, without any user confirmation', async t => {
  const f = extensionEntryFixture();
  t.after(async () => {
    f.opened.resolve(f.application);
    f.finishUpgrade.resolve();
    await f.deactivate();
  });
  f.activate(f.context);
  assert.equal(f.events.includes('open'), false);
  const ready = f.startup.wait();
  await f.opening.promise;
  // Keep Runtime opening across an event-loop turn: activation must not migrate other roots yet.
  await new Promise(setImmediate);
  assert.equal(f.startup.current(), undefined);
  assert.equal(f.calls.some(call => call[0] === 'auto-upgrade'), false);

  f.opened.resolve(f.application);
  assert.equal(await ready, f.application);
  assert.equal(f.calls.some(call => call[0] === 'auto-upgrade'), false);
  const options = await f.upgradeStarted.promise;
  assert.equal(options.excludeSelected, true);
  assert.equal(options.shouldContinue(), true);
  assert.deepEqual(f.calls.filter(call => call[0] === 'auto-upgrade'), [['auto-upgrade', true, true]]);
  assert.equal(f.calls.some(call => ['pick', 'warning', 'select', 'command', 'history'].includes(call[0])), false);
});

test('extension deactivation starts Runtime disposal immediately and awaits the in-flight historical upgrade', async t => {
  const f = extensionEntryFixture();
  t.after(async () => {
    f.finishUpgrade.resolve();
    await f.deactivate();
  });
  f.activate(f.context);
  const ready = f.startup.wait();
  await f.opening.promise;
  f.opened.resolve(f.application);
  await ready;
  const options = await f.upgradeStarted.promise;
  assert.equal(options.shouldContinue(), true);

  let stopped = false;
  const shutdown = f.deactivate().then(() => { stopped = true; });
  assert.equal(options.shouldContinue(), false);
  await new Promise(setImmediate);
  assert.equal(stopped, false);
  assert.equal(f.events.includes('dispose'), true);
  assert.equal(f.events.includes('upgrade-finished'), false);

  f.finishUpgrade.resolve();
  await shutdown;
  assert.equal(stopped, true);
  assert.equal(f.events.includes('next-source'), false);
  assert.ok(f.events.indexOf('dispose') < f.events.indexOf('upgrade-finished'));
  assert.equal(f.events.filter(event => event === 'dispose').length, 1);
  assert.equal(f.calls.some(call => ['pick', 'warning', 'select', 'command'].includes(call[0])), false);
});

for (const fails of [false, true]) test(`deactivation waits for an on-demand history upgrade without a Runtime, suppressing its ${fails ? 'failure' : 'success'} UI`, async t => {
  const f = extensionEntryFixture({ onDemand: true, upgradeError: fails ? new Error('fixture upgrade failed') : undefined });
  t.after(async () => {
    f.finishUpgrade.resolve();
    await f.deactivate();
  });
  f.activate(f.context);
  const browsing = f.management.manageRuntimeDataSets(f.context, f.startup);
  await f.upgradeStarted.promise;
  assert.equal(f.startup.current(), undefined);
  assert.equal(f.events.includes('open'), false);
  let stopped = false;
  const shutdown = f.deactivate().then(() => { stopped = true; });
  assert.equal(f.lifetime.canStartRuntimeDataSetUpgrade(f.context), false);
  await new Promise(setImmediate);
  assert.equal(stopped, false);
  assert.equal(f.events.includes('dispose'), false);
  const beforeNewRequests = f.calls.length;
  await f.management.upgradeHistoricalDataSetsOnStartup(f.context);
  await f.management.manageRuntimeDataSets(f.context, f.startup);
  assert.equal(f.calls.length, beforeNewRequests);
  await assert.rejects(f.lifetime.runRuntimeDataSetUpgrade(f.context, async () => {
    assert.fail('shutdown admitted another upgrade');
  }), { code: 'runtime-dataset-upgrades-stopped' });

  f.finishUpgrade.resolve();
  await Promise.all([browsing, shutdown]);
  assert.equal(stopped, true);
  assert.equal(f.events.includes('open'), false);
  assert.equal(f.calls.filter(call => call[0] === 'upgrade').length, 1);
  assert.equal(f.calls.some(call => ['history', 'document', 'error', 'warning', 'info', 'select', 'command'].includes(call[0])), false);
});

test('upgrade lifetime closes admission before a registered operation starts and keeps contexts independent', async () => {
  const lifetime = loadSource('vscode/runtimeDataSetUpgradeLifetime.ts', {});
  const stoppedContext = {};
  const otherContext = {};
  let invoked = false;
  const queued = lifetime.runRuntimeDataSetUpgrade(stoppedContext, async () => { invoked = true; });
  const stopped = lifetime.stopRuntimeDataSetUpgrades(stoppedContext);
  assert.equal(lifetime.canStartRuntimeDataSetUpgrade(stoppedContext), false);
  await assert.rejects(queued, { code: 'runtime-dataset-upgrades-stopped' });
  await stopped;
  assert.equal(invoked, false);
  assert.equal(await lifetime.runRuntimeDataSetUpgrade(otherContext, async () => 'unaffected'), 'unaffected');
  await lifetime.stopRuntimeDataSetUpgrades(otherContext);
});


test('after Runtime ready old libraries merge online in the background without any question or reload', async () => {
  const f = fixture({ mergeReport: emptyMergeReport({
    merged: [{ candidateId: 'workspace:old', insertedRows: 12, insertedConversations: 3, backupPath: '/fixture/merge-backup',
      finalized: { turns: 2, intents: 1, sourceBackupPath: '/fixture/old-backup' } }]
  }) });
  await f.mergeHistoricalDataSetsInBackground(f.context, mergeHost());
  assert.deepEqual(f.calls.filter(call => call[0] === 'merge-online'), [['merge-online', 'this-window', true, null]]);
  const info = f.calls.find(call => call[0] === 'info')[1];
  assert.match(info, /已把 1 份旧聊天记录合并到当前历史库（新增 3 个对话）/);
  assert.match(info, /其中 2 个中断的任务已按“中止”收尾，不会被继续执行。另有 1 条排队未发送的消息已取消。/);
  assert.equal(f.calls.some(call => ['pick', 'warning', 'select', 'command', 'history', 'upgrade', 'exclusive'].includes(call[0])), false);
});

test('background merge reports new outcomes once, stays silent for known ones and never throws', async () => {
  const blocked = { candidateId: 'workspace:old', code: 'runtime-data-set-merge-unfinished-work', message: '还有等待你回答的请求' };
  const known = fixture({ mergeReport: emptyMergeReport({ blocked: [{ ...blocked, newly: false }] }) });
  await known.mergeHistoricalDataSetsInBackground(known.context, mergeHost());
  assert.equal(known.calls.some(call => ['warning', 'info'].includes(call[0])), false);
  const fresh = fixture({ mergeReport: emptyMergeReport({ blocked: [{ ...blocked, newly: true }] }) });
  await fresh.mergeHistoricalDataSetsInBackground(fresh.context, mergeHost());
  assert.match(fresh.calls.find(call => call[0] === 'warning')[1],
    /未能合并到当前库，当前库的对话没有改动；各库的情况（例如已发布的旧格式先备份并就地升级、中断的任务已收尾）见原因/);
  const deferredIssue = { candidateId: 'workspace:old', code: 'runtime-hosts-active', message: '这个历史库正被其它窗口使用', newly: true };
  const deferred = fixture({ mergeReport: emptyMergeReport({ deferred: [deferredIssue] }) });
  await deferred.mergeHistoricalDataSetsInBackground(deferred.context, mergeHost());
  assert.match(deferred.calls.find(call => call[0] === 'info')[1], /1 份旧聊天记录暂时无法合并（这个历史库正被其它窗口使用），以后启动时会自动重试/);
  const failing = fixture({ mergeError: Object.assign(new Error('磁盘已满'), { code: 'ENOSPC' }) });
  await failing.mergeHistoricalDataSetsInBackground(failing.context, mergeHost());
  assert.match(failing.calls.find(call => call[0] === 'warning')[1], /暂时无法合并.*磁盘已满/);
  const stopped = fixture({ mergeError: new Error('写入失败。') });
  await stopped.mergeHistoricalDataSetsInBackground(stopped.context, mergeHost());
  assert.match(stopped.calls.find(call => call[0] === 'warning')[1], /暂时无法合并：写入失败。已有数据未被修改/, '拼接处不出现“。。”');
  const period = fixture({ mergeReport: emptyMergeReport({ deferred: [{ ...deferredIssue, message: '这个历史库正被其它窗口使用。' }] }) });
  await period.mergeHistoricalDataSetsInBackground(period.context, mergeHost());
  assert.match(period.calls.find(call => call[0] === 'info')[1], /暂时无法合并（这个历史库正被其它窗口使用），以后启动时会自动重试/);
  const obsolete = fixture();
  await obsolete.mergeHistoricalDataSetsInBackground(obsolete.context, mergeHost(), () => false);
  assert.equal(obsolete.calls.some(call => call[0] === 'merge-online'), false);
});

test('an automatic merge that gave way to another window merging the same source says nothing; a requested one still says why (blind review #4)', async () => {
  const superseded = {
    candidateId: 'workspace:old', code: 'runtime-data-set-merge-exclusive-superseded',
    message: '另一个窗口正在进行同一项维护（合并较大的旧聊天记录），这次由它完成。', newly: true
  };
  const quiet = fixture({ mergeReport: emptyMergeReport({ deferred: [superseded] }) });
  await quiet.mergeHistoricalDataSetsInBackground(quiet.context, mergeHost());
  assert.equal(quiet.calls.some(call => ['warning', 'info'].includes(call[0])), false);
  const requested = fixture({ mergeReport: emptyMergeReport({ deferred: [{ ...superseded, requested: true }] }) });
  await requested.mergeHistoricalDataSetsInBackground(requested.context, mergeHost());
  assert.match(requested.calls.find(call => call[0] === 'info')[1], /暂时无法合并（另一个窗口正在进行同一项维护（合并较大的旧聊天记录），这次由它完成）/);
});

test('only an oversized source the engine prepared asks other windows to yield, keyed by that source state', async () => {
  const withLocks = body => body();
  const isDeterministicFailure = () => false;
  const oversized = requested => ({
    targetPaths: { dataRootPath: '/fixture/current' }, requesterHostBootId: 'this-window',
    candidateId: 'workspace:old', operationKey: 'workspace:old@0123456789abcdef', requested, withLocks, isDeterministicFailure
  });
  for (const [requested, outcome] of [[false, 'completed'], [false, 'busy'], [true, 'completed']]) {
    let merged = false;
    let result;
    const f = fixture({ exclusiveOutcome: outcome, mergeHook: async options => {
      result = await options.coordinateOversized(oversized(requested), async () => { merged = true; });
    } });
    await f.mergeHistoricalDataSetsInBackground(f.context, mergeHost());
    const [call] = f.calls.filter(item => item[0] === 'exclusive');
    assert.equal(call[1], '/fixture/current');
    assert.deepEqual(call[2], {
      operation: 'historical-merge', operationKey: 'workspace:old@0123456789abcdef', message: '为合并较大的旧聊天记录',
      waitingTitle: '正在等待其它窗口空闲后合并较大的旧聊天记录', configurationRootPath: '/fixture',
      requesterHostBootId: 'this-window', ignoreBackoff: requested,
      ...(requested ? { whenBusy: 'wait', participantConfirmation: 'notice' } : {}),
      isDeterministicFailure, withLocks
    }, '引擎在锁外调用：等忙窗口不持锁，全部就绪后才用引擎给的 withLocks 拿锁');
    assert.equal(call[3], true);
    assert.equal(merged, outcome === 'completed');
    assert.deepEqual(plain(result), outcome === 'completed' ? { state: 'completed' } : { state: 'busy', reason: '有 1 个窗口正在忙（有任务正在进行）' });
  }
});

test('startup notices accumulate by cause: an unevaluated cause is kept, a user-requested outcome is always shown', async () => {
  const values = new Map();
  const globalState = { get: key => values.get(key), update: async (key, value) => { values.set(key, value); } };
  const busy = { candidateId: 'workspace:old', code: 'runtime-hosts-active', message: '正被旧窗口使用', newly: true };
  const denied = { candidateId: 'workspace:other', code: 'EACCES', message: '没有权限', newly: true };
  const merged = candidateId => ({ candidateId, insertedRows: 1, insertedConversations: 1, backupPath: '/fixture/backup' });
  const notices = async (mergeReport, candidateIds) => {
    const f = fixture({ globalState, mergeReport });
    await f.mergeHistoricalDataSetsInBackground(f.context, mergeHost(), () => true, candidateIds);
    return f.calls.filter(call => ['warning', 'info'].includes(call[0])).map(call => call[1]);
  };
  assert.equal((await notices(emptyMergeReport({ deferred: [busy], failures: [denied] }))).length, 2);
  assert.deepEqual(await notices(emptyMergeReport({ deferred: [busy], failures: [denied] })), []);
  // Only the other library was evaluated this time: its cause clears, the old library's stays.
  assert.equal((await notices(emptyMergeReport({ merged: [merged('workspace:other')] }))).length, 1);
  assert.deepEqual(await notices(emptyMergeReport({ deferred: [busy] })), [], '未评估的原因不会被清掉后重复提示');
  assert.equal((await notices(emptyMergeReport({ failures: [denied] }))).length, 1, '清掉后再出现会重新提示');
  assert.equal((await notices(emptyMergeReport({ deferred: [{ ...busy, requested: true }] }))).length, 1, '用户明确请求的结果总是提示');
  assert.equal((await notices(emptyMergeReport({ blocked: [{ ...busy, code: 'runtime-data-set-merge-conflict', newly: false, requested: true }] }))).length, 1);

  const upgrades = async () => {
    const f = fixture({ globalState, batchReport: { results: [], failures: [denied] } });
    await f.upgradeHistoricalDataSetsOnStartup(f.context);
    return f.calls.filter(call => call[0] === 'warning').length;
  };
  assert.equal(await upgrades(), 1);
  assert.equal(await upgrades(), 0);
});

test('explicit merge runs online in this window without a reload; without a Runtime it is recorded for the next start', async () => {
  const cancelled = fixture({ picks: [action('merge'), 0], application: mergeHost() });
  await cancelled.manageRuntimeDataSets(cancelled.context, cancelled.startup);
  assert.equal(cancelled.calls.some(call => ['merge-request', 'merge-online', 'command'].includes(call[0])), false);

  const f = fixture({ application: mergeHost(), confirmation: '合并', picks: [action('merge'), items => {
    assert.deepEqual(Array.from(items, item => item.candidate?.id), ['workspace:old']);
    return items[0];
  }], mergeReport: emptyMergeReport({ blocked: [{
    candidateId: 'workspace:old', code: 'runtime-data-set-merge-unfinished-work', message: '还有等待你回答的请求', newly: false, requested: true
  }] }) });
  await f.manageRuntimeDataSets(f.context, f.startup);
  const confirm = f.calls.find(call => call[0] === 'warning' && call[1] === '把这个历史库合并到当前库？');
  assert.match(confirm[2].detail, /不需要重载窗口/);
  assert.match(confirm[2].detail, /已发布的旧格式会先备份并就地升级/);
  assert.match(confirm[2].detail, /原库里中断的任务按“中止”收尾、排队未发送的消息会被取消，都不会在当前库被继续执行/);
  // 盲审 merge #1：再次合并不插回用户在当前库删掉的对话，确认框如实写明。
  assert.match(confirm[2].detail, /以前从这个库合并进当前库、之后你在当前库删除了的对话不会再合并回来（连同它们的子 Agent 对话，在这个库里继续过的也一样）/);
  // 复审 merge3 #2：明确合并对超限来源会等其它窗口（与协调参数 whenBusy: 'wait' 一致），条件写具体数字。
  assert.match(confirm[2].detail, /超过 1234 条记录或 5 MiB 的库需要其它窗口暂时让出：会在后台等其它窗口的任务结束、正在使用的窗口被切走（最多约 7 分钟，可取消），然后其它窗口会重载一次/);
  // 大库会话：超过内存单事务上限的在所有窗口暂停时合并，超过流式硬上限的才不能合并。
  // The engine's two size bounds: above the in-memory one the large merge session, above the streamed one too large.
  assert.match(confirm[2].detail, /超过 5\.7 万条、不到 9877 万条记录的库在“大库会话”里合并：先在后台准备（窗口照常可用），再单独确认一次，然后所有 LimCode 窗口暂停并显示进度，完成后自动恢复；/);
  assert.match(confirm[2].detail, /超过 9877 万条记录的库当前版本不能安全合并/);
  assert.doesNotMatch(confirm[2].detail, /这次先不合并，之后会再试|特别大/);
  assert.deepEqual(plain(f.calls.filter(call => ['merge-request', 'merge-online', 'command'].includes(call[0]))), [
    ['merge-request', 'workspace:old', 'old', 'old-instance'],
    ['merge-online', 'this-window', true, ['workspace:old']]
  ], '在线合并，不重载窗口');
  assert.ok(f.calls.some(call => call[0] === 'warning' && /未能合并到当前库/.test(call[1])), '用户请求的结果即使不是新原因也提示');

  const offline = fixture({ confirmation: '合并', picks: [action('merge'), 0] });
  await offline.manageRuntimeDataSets(offline.context, offline.startup);
  assert.deepEqual(offline.calls.filter(call => ['merge-request', 'merge-online', 'command'].includes(call[0])),
    [['merge-request', 'workspace:old', 'old', 'old-instance']]);
  assert.match(offline.calls.find(call => call[0] === 'info')[1], /已记录合并请求/);

  const done = fixture({ picks: [action('merge')], mergeStates: { 'workspace:old': { state: 'merged', mergedAt: '2026-09-26', intoCurrent: true, changedSinceMerge: false } } });
  await done.manageRuntimeDataSets(done.context, done.startup);
  assert.match(done.calls.find(call => call[0] === 'info')[1], /都已合并到当前库/);
});

test('library pickers show folder names, conversation counts, last activity and merge state instead of ids', async () => {
  const summaries = { 'workspace:old': { projectNames: ['limcode', 'notes'], conversationCount: 12, lastActivityAt: '2026-09-24T08:00:00.000Z' } };
  const changed = { 'workspace:old': { state: 'merged', mergedAt: '2026-09-20', intoCurrent: true, changedSinceMerge: true } };
  let shown;
  const f = fixture({ summaries, mergeStates: changed, picks: [action('merge'), items => { shown = items; return undefined; }] });
  await f.manageRuntimeDataSets(f.context, f.startup);
  assert.equal(shown.length, 1, '合并后有新变化的库仍可再次合并');
  assert.equal(shown[0].label, '其他历史库 · limcode、notes · 已合并，但合并后有新变化');
  assert.match(shown[0].description, /^12 个对话 · 最后活动 2026-09-2\d \d\d:\d\d$/);
  assert.equal(/old-instance|\bold\b/.test(shown[0].label), false);
  assert.deepEqual(f.calls.filter(call => call[0] === 'summarize'), [['summarize', 'workspace:old']], '本窗口打开着的当前库不做快照');

  const kept = fixture({ mergeStates: { 'workspace:old': { state: 'kept' } }, picks: [action('history'), items => { shown = items; return undefined; }] });
  await kept.manageRuntimeDataSets(kept.context, kept.startup);
  assert.equal(shown[0].label, '其他历史库 · 旧工作区历史 · 你保留的库（不自动合并）');

  const warned = fixture({ mergeStates: changed, picks: [action('delete'), 0], confirmation: '永久删除' });
  await warned.manageRuntimeDataSets(warned.context, warned.startup);
  assert.match(warned.calls.find(call => call[0] === 'warning')[2].detail, /上次合并之后又有改动.*没有合并进任何库，删除会永久丢失/);
});

test('merge state shows a missing merge target and keeps deletion warnings after a later attempt fails', async () => {
  const facts = { mergedAt: '2026-09-20', intoCurrent: false, targetMissing: true, changedSinceMerge: false };
  let shown;
  const missing = fixture({ mergeStates: { 'workspace:old': { state: 'merged', ...facts } }, picks: [action('merge'), items => { shown = items; return undefined; }] });
  await missing.manageRuntimeDataSets(missing.context, missing.startup);
  assert.equal(shown.length, 1, '合并目标已不存在的库重新出现在“合并到当前库”列表里');
  assert.equal(shown[0].label, '其他历史库 · 旧工作区历史 · 曾合并到的库已不存在或无法读取');
  const deleting = fixture({ mergeStates: { 'workspace:old': { state: 'merged', ...facts } }, picks: [action('delete'), 0], confirmation: '永久删除' });
  await deleting.manageRuntimeDataSets(deleting.context, deleting.startup);
  assert.match(deleting.calls.find(call => call[0] === 'warning')[2].detail, /曾合并到的库已被删除、重置或暂时无法读取.*删除会永久丢失/);

  const elsewhere = fixture({ mergeStates: { 'workspace:old': { state: 'merged', ...facts, targetMissing: false } }, picks: [action('delete'), 0], confirmation: '永久删除' });
  await elsewhere.manageRuntimeDataSets(elsewhere.context, elsewhere.startup);
  assert.match(elsewhere.calls.find(call => call[0] === 'warning')[2].detail, /已合并到另一个现存的历史库/);

  const lastMerged = { mergedAt: '2026-09-20', intoCurrent: true, targetMissing: false, changedSinceMerge: true };
  const blocked = { state: 'blocked', code: 'runtime-data-set-merge-conflict', message: '冲突', lastMerged };
  const failedAgain = fixture({ mergeStates: { 'workspace:old': blocked }, picks: [action('delete'), items => { shown = items; return items[0]; }], confirmation: '永久删除' });
  await failedAgain.manageRuntimeDataSets(failedAgain.context, failedAgain.startup);
  assert.equal(shown[0].label, '其他历史库 · 旧工作区历史 · 之前合并过，再次合并未成功');
  assert.match(failedAgain.calls.find(call => call[0] === 'warning')[2].detail, /上次合并之后又有改动.*删除会永久丢失/,
    '再次合并受阻后，删除确认仍警告合并后的改动会丢失');

  const never = fixture({ mergeStates: { 'workspace:old': { state: 'kept' } }, picks: [action('delete'), 0], confirmation: '永久删除' });
  await never.manageRuntimeDataSets(never.context, never.startup);
  assert.match(never.calls.find(call => call[0] === 'warning')[2].detail, /还没有合并到任何库，删除后会永久丢失/);

  const remerge = fixture({ application: mergeHost(), mergeStates: { 'workspace:old': blocked }, picks: [action('merge'), 0] });
  await remerge.manageRuntimeDataSets(remerge.context, remerge.startup);
  const detail = remerge.calls.find(call => call[0] === 'warning' && call[1] === '把这个历史库合并到当前库？')[2].detail;
  assert.match(detail, /只新建过对话时，新对话会合并进来.*在已合并、当前库里也还在的对话里继续过时.*整体不合并/);
  assert.doesNotMatch(detail, /两边都改过/);
});

test('switching away explains the kept rule and warns before continuing merged conversations in the target', async () => {
  const facts = { mergedAt: '2026-09-20', intoCurrent: true, targetMissing: false, changedSinceMerge: false };
  const f = fixture({ mergeStates: { 'workspace:old': { state: 'merged', ...facts } }, picks: [action('select'), 1] });
  await f.manageRuntimeDataSets(f.context, f.startup);
  const detail = f.calls.find(call => call[0] === 'warning' && call[1] === '切换当前历史库并重载窗口？')[2].detail;
  assert.match(detail, /现在的当前库会记为“你保留的库”，以后只在你选择“合并到当前库”时才合并/);
  assert.match(detail, /还没合并过、也不是你保留的旧库，会在下次打开时自动合并进新的当前库/);
  assert.match(detail, /在已合并的对话里继续聊天，这个库以后就不能再合并回当前库.*只新建对话.*新对话以后仍可合并回来/);
  assert.match(detail, /从这个库合并进当前库、之后在当前库删除了的对话，以后再合并时不会被插回（在这个库里继续过也一样）/);
  assert.equal(f.calls.some(call => ['select', 'command'].includes(call[0])), false, '未确认不切换');

  // Changed since the merge (or unreadable now): the rule for deleted conversations still holds.
  for (const changed of [{ changedSinceMerge: true }, { sourceUnreadable: true }]) {
    const later = fixture({ mergeStates: { 'workspace:old': { state: 'merged', ...facts, ...changed } }, picks: [action('select'), 1] });
    await later.manageRuntimeDataSets(later.context, later.startup);
    const text = later.calls.find(call => call[0] === 'warning' && call[1] === '切换当前历史库并重载窗口？')[2].detail;
    assert.doesNotMatch(text, /这个库的对话已合并到当前库/);
    assert.match(text, /之后在当前库删除了的对话，以后再合并时不会被插回/);
  }
});

const mergedOld = overrides => ({
  candidateId: 'workspace:old', sourceDataSetId: 'old', targetDataSetId: 'current', insertedRows: 12, reusedRows: 0,
  insertedConversations: 1, linkedCasObjects: 0, copiedCasObjects: 0, reusedCasObjects: 0, recoveredCommit: false,
  backupPath: '/fixture/backup', ...overrides
});

test('盲审 merge #3：合并通知与日志写明取消的排队消息；只取消了排队消息时不提中断的任务', async () => {
  const f = fixture({ mergeReport: emptyMergeReport({ merged: [
    mergedOld({ finalized: { turns: 0, intents: 2, sourceBackupPath: '/fixture/source-backup' } })
  ] }) });
  await f.mergeHistoricalDataSetsInBackground(f.context, mergeHost(), () => true);
  assert.deepEqual(f.calls.filter(call => call[0] === 'info').map(call => call[1]), [
    '已把 1 份旧聊天记录合并到当前历史库（新增 1 个对话），可直接在侧栏继续。另有 2 条排队未发送的消息已取消。原库和合并前备份都已保留。'
  ]);
  assert.deepEqual(f.logs.filter(([level]) => level === 'info').map(([, line]) => line), [
    '[LimCode] 已合并旧聊天记录 workspace:old：新增 12 行；合并前备份：/fixture/backup；收尾 0 个中断任务，另有 2 条排队未发送的消息已取消，'
    + '收尾前来源备份：/fixture/source-backup'
  ]);
});

test('盲审 merge #1：通知与日志报出以前合并进来、之后在当前库删除而这次没有再合并回来的对话数', async () => {
  const f = fixture({ mergeReport: emptyMergeReport({ merged: [mergedOld({ skippedConversations: 3 })] }) });
  await f.mergeHistoricalDataSetsInBackground(f.context, mergeHost(), () => true);
  assert.deepEqual(f.calls.filter(call => call[0] === 'info').map(call => call[1]), [
    '已把 1 份旧聊天记录合并到当前历史库（新增 1 个对话），可直接在侧栏继续。有 3 个对话以前合并进来、之后你在当前库删除了，这次没有再合并回来。'
    + '原库和合并前备份都已保留。'
  ]);
  assert.deepEqual(f.logs.filter(([level]) => level === 'info').map(([, line]) => line), [
    '[LimCode] 已合并旧聊天记录 workspace:old：新增 12 行；合并前备份：/fixture/backup；3 个之前合并进来、之后在当前库删除的对话没有再合并'
  ]);
});

test('外来历史库合并：通知与日志用可读名称，并提示这份归档或拷来的库可以在“清理备份”里按覆盖核对删除；没有新内容时同样提示；原因列表也用名称', async () => {
  const id = 'foreign:archive:0123456789abcdef';
  const label = '外来历史库（归档 · 20260901-010203-004-abcdef12）';
  const tip = `${label}原样保留；确认不再需要时，可以在“清理备份”里按覆盖核对后删除。`;
  const merged = fixture({ mergeReport: emptyMergeReport({ merged: [mergedOld({ candidateId: id, label, copiedCasObjects: 3 })] }) });
  await merged.mergeHistoricalDataSetsInBackground(merged.context, mergeHost(), () => true, [id]);
  assert.deepEqual(merged.calls.filter(call => call[0] === 'info').map(call => call[1]), [
    `已把 1 份旧聊天记录合并到当前历史库（新增 1 个对话），可直接在侧栏继续。原库和合并前备份都已保留。${tip}`
  ]);
  assert.deepEqual(merged.logs.filter(([level]) => level === 'info').map(([, line]) => line), [
    `[LimCode] 已合并旧聊天记录 ${label}（${id}）：新增 12 行；合并前备份：/fixture/backup`
  ]);
  const again = fixture({ mergeReport: emptyMergeReport({ merged: [mergedOld({
    candidateId: id, label, alreadyMerged: true, insertedRows: 0, insertedConversations: 0, backupPath: undefined
  })] }) });
  await again.mergeHistoricalDataSetsInBackground(again.context, mergeHost(), () => true, [id]);
  assert.deepEqual(again.calls.filter(call => call[0] === 'info').map(call => call[1]), [`所选历史库已合并到当前历史库，没有新内容。${tip}`]);
  const local = fixture({ mergeReport: emptyMergeReport({ merged: [mergedOld()] }) });
  await local.mergeHistoricalDataSetsInBackground(local.context, mergeHost(), () => true);
  assert.doesNotMatch(local.calls.find(call => call[0] === 'info')[1], /清理备份/, '本地历史库的合并不提清理备份');

  const refused = fixture({ confirmation: '查看原因', mergeReport: emptyMergeReport({ blocked: [{
    candidateId: id, label, code: 'runtime-data-set-merge-foreign-old-copy', message: '这个外来历史库是当前历史库的旧拷贝。', newly: true, requested: true
  }] }) });
  await refused.mergeHistoricalDataSetsInBackground(refused.context, mergeHost(), () => true, [id]);
  for (let turn = 0; turn < 50 && !refused.calls.some(call => call[0] === 'document'); turn += 1) await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(refused.calls.find(call => call[0] === 'document'), ['document',
    `${label}\n[runtime-data-set-merge-foreign-old-copy] 这个外来历史库是当前历史库的旧拷贝。`]);
});

test('盲审 merge #4：明确合并时已合并、没有新内容也有回应，引擎什么都没做时同样回应；自动合并没有可说的就静默', async () => {
  const already = {
    candidateId: 'workspace:old', sourceDataSetId: 'old', targetDataSetId: 'current', insertedRows: 0, reusedRows: 0,
    insertedConversations: 0, linkedCasObjects: 0, copiedCasObjects: 0, reusedCasObjects: 0, recoveredCommit: false, alreadyMerged: true
  };
  const explicit = async mergeReport => {
    const f = fixture({ picks: [action('merge'), 0], confirmation: '合并', application: mergeHost(), mergeReport });
    await f.manageRuntimeDataSets(f.context, f.startup);
    return f.calls.filter(call => ['info', 'warning', 'error'].includes(call[0]) && call[1] !== '把这个历史库合并到当前库？').map(call => call[1]);
  };
  assert.deepEqual(await explicit(emptyMergeReport({ merged: [already] })), ['所选历史库已合并到当前历史库，没有新内容。']);
  assert.deepEqual(await explicit(emptyMergeReport()), ['这次没有合并：所选历史库已不在，或者当前历史库已经切换。可以重新打开“历史与存储管理”查看。']);
  assert.deepEqual(await explicit(emptyMergeReport({ stopped: true })), [], '停止（窗口关闭或切库）时不回应');

  const quiet = fixture({ mergeReport: emptyMergeReport() });
  await quiet.mergeHistoricalDataSetsInBackground(quiet.context, mergeHost());
  assert.equal(quiet.calls.some(call => ['info', 'warning'].includes(call[0])), false);
  const closed = fixture({ mergeReport: emptyMergeReport({ merged: [{ ...already, finalized: { turns: 1, intents: 0, sourceBackupPath: '/fixture/source-backup' } }] }) });
  await closed.mergeHistoricalDataSetsInBackground(closed.context, mergeHost());
  assert.deepEqual(closed.calls.filter(call => call[0] === 'info').map(call => call[1]),
    ['1 份旧聊天记录已合并到当前历史库，没有新内容。其中 1 个中断的任务已按“中止”收尾，不会被继续执行。'], '收尾过的工作照样说明');
});

test('盲审 merge #4：读不出内容的已合并库显示“无法读取”，不当成合并后有新变化；仍可再次合并，合并与删除的确认如实说明', async () => {
  const unreadable = { 'workspace:old': {
    state: 'merged', mergedAt: '2026-09-20', intoCurrent: true, targetMissing: false, changedSinceMerge: false, sourceUnreadable: true
  } };
  let shown;
  const listed = fixture({ mergeStates: unreadable, picks: [action('merge'), items => { shown = items; return undefined; }] });
  await listed.manageRuntimeDataSets(listed.context, listed.startup);
  assert.equal(shown.length, 1, '读不出来时不能断定已合并且没变化，仍列在“合并到当前库”里');
  assert.equal(shown[0].label, '其他历史库 · 旧工作区历史 · 已合并，现在无法读取（不能判断合并后有没有变化）');
  const merging = fixture({ application: mergeHost(), mergeStates: unreadable, picks: [action('merge'), 0] });
  await merging.manageRuntimeDataSets(merging.context, merging.startup);
  const detail = merging.calls.find(call => call[0] === 'warning' && call[1] === '把这个历史库合并到当前库？')[2].detail;
  assert.match(detail, /现在无法读取这个库，不能确认它在上次合并之后有没有改动；合并时会重新核验，读不出来会说明原因。/);
  assert.doesNotMatch(detail, /又有改动：/);
  const deleting = fixture({ mergeStates: unreadable, picks: [action('delete'), 0], confirmation: '永久删除' });
  await deleting.manageRuntimeDataSets(deleting.context, deleting.startup);
  assert.match(deleting.calls.find(call => call[0] === 'warning')[2].detail,
    /现在无法读取这个库，不能确认它在上次合并之后有没有改动；如果有，删除后这些改动会永久丢失/);
});

test('盲审 merge #6：列表摘要在该库的 admission 与 maintenance 里读取；没有数据的库不读也不显示读取失败', async () => {
  let shown;
  const f = fixture({ picks: [action('history'), items => { shown = items; return undefined; }] });
  await f.manageRuntimeDataSets(f.context, f.startup);
  assert.deepEqual(plain(f.calls.filter(call => ['claims', 'summarize', 'claims-released'].includes(call[0]))),
    [['claims', 'workspace:old'], ['summarize', 'workspace:old'], ['claims-released', 'workspace:old']]);
  const empty = fixture({ emptyOld: true, picks: [action('history'), items => { shown = items; return undefined; }] });
  await empty.manageRuntimeDataSets(empty.context, empty.startup);
  assert.equal(empty.calls.some(call => ['claims', 'summarize'].includes(call[0])), false);
  assert.doesNotMatch(shown[0].description, /读取失败/);
});

test('跨模块盲审 #7：磁盘空间不足的推迟只在新原因出现时提示，所需空间的数字变了也不重复提示', async () => {
  const values = new Map();
  const globalState = { get: key => values.get(key), update: async (key, value) => { values.set(key, value); } };
  const full = megabytes => ({ candidateId: 'workspace:old', code: 'runtime-data-set-merge-disk-full', newly: true,
    message: `磁盘空间不足，需要约 ${megabytes} MB：合并前要先在 /fixture/current 备份当前历史库` });
  const notices = async issue => {
    const f = fixture({ globalState, mergeReport: emptyMergeReport({ deferred: [issue] }) });
    await f.mergeHistoricalDataSetsInBackground(f.context, mergeHost());
    return f.calls.filter(call => ['warning', 'info'].includes(call[0])).map(call => call[1]);
  };
  assert.deepEqual(await notices(full(120)),
    ['有 1 份旧聊天记录暂时无法合并（磁盘空间不足，需要约 120 MB：合并前要先在 /fixture/current 备份当前历史库），以后启动时会自动重试。']);
  assert.deepEqual(await notices(full(121)), [], '之后每次启动同一原因都不再提示');
});

test('a library whose summary cannot be read says so instead of looking empty', async () => {
  let shown;
  const f = fixture({ summaries: { 'workspace:old': new Error('EACCES') }, picks: [action('history'), items => { shown = items; return undefined; }] });
  await f.manageRuntimeDataSets(f.context, f.startup);
  assert.match(shown[0].description, /对话数和最后活动读取失败（只是没读到，库没有被改动）/);
});

test('startup picker names every library and shows a preflight rejection on the library itself', async () => {
  const summaries = {
    default: { projectNames: ['limcode'], conversationCount: 5, lastActivityAt: '2026-09-25T10:00:00.000Z' },
    'workspace:old': { projectNames: ['notes'], conversationCount: 2, lastActivityAt: '2026-09-01T10:00:00.000Z' }
  };
  const problems = [{ id: 'workspace:old', runtimeScopeRootPath: '/fixture/old', message: '这个历史库的结构或完整性核验未通过：missing index' }];
  let shown;
  const f = fixture({ summaries, problems, picks: [items => { shown = items; return items[0]; }] });
  let opens = 0;
  await f.openWithRuntimeDataSetSelection(f.context, async () => { if (++opens === 1) throw new f.SelectionRequired(); return 'ready'; });
  assert.equal(shown.length, 2, '被预检拒绝的库不再重复列成单独的问题项');
  assert.deepEqual(plain(shown.map(item => item.label)), ['当前历史库 · limcode', 'notes'], '启动选择时没有“其他历史库”');
  assert.match(shown[1].description, /^暂时无法自动打开 · 2 个对话/);
  assert.match(shown[1].detail, /打开前检查未通过：这个历史库的结构或完整性核验未通过/);
  assert.deepEqual(f.calls.filter(call => call[0] === 'select'), [['select', 'default']]);
});

test('extension merges old libraries online only after Runtime ready and after the background upgrades', async t => {
  const f = extensionEntryFixture();
  t.after(async () => {
    f.opened.resolve(f.application);
    f.finishUpgrade.resolve();
    await f.deactivate();
  });
  f.activate(f.context);
  const ready = f.startup.wait();
  await f.opening.promise;
  assert.deepEqual(Object.keys(f.openOptions[0]), ['onRuntimeWait', 'onRuntimeWaitOver'], 'Runtime open 不再带启动前合并钩子，只带等待说明');
  f.opened.resolve(f.application);
  await ready;
  await f.upgradeStarted.promise;
  await new Promise(setImmediate);
  assert.equal(f.calls.some(call => call[0] === 'merge-online'), false, '升级完成之前不合并');
  f.finishUpgrade.resolve();
  for (let i = 0; i < 10 && !f.calls.some(call => call[0] === 'merge-online'); i += 1) await new Promise(setImmediate);
  assert.deepEqual(f.calls.filter(call => call[0] === 'merge-online'), [['merge-online', 'this-window', true, null]]);
  assert.equal(f.calls.some(call => ['pick', 'warning', 'select', 'command'].includes(call[0])), false);
});

test('extension joins exclusive maintenance only after Runtime ready and leaves it on deactivation', async t => {
  const f = extensionEntryFixture();
  t.after(async () => {
    f.opened.resolve(f.application);
    f.finishUpgrade.resolve();
    await f.deactivate();
  });
  f.activate(f.context);
  const ready = f.startup.wait();
  await f.opening.promise;
  await new Promise(setImmediate);
  assert.equal(f.events.some(event => Array.isArray(event) && event[0] === 'participant-start'), false);
  f.opened.resolve(f.application);
  await ready;
  for (let i = 0; i < 5 && !f.events.some(event => Array.isArray(event) && event[0] === 'participant-start'); i += 1) {
    await new Promise(setImmediate);
  }
  assert.deepEqual(f.events.find(event => Array.isArray(event) && event[0] === 'participant-start'), ['participant-start', true, true]);
  f.finishUpgrade.resolve();
  await f.deactivate();
  assert.equal(f.events.filter(event => event === 'participant-dispose').length, 1);
});

test('the reason kept across a reload is judged by when this window started opening again, not after it waited (blind review #5)', async t => {
  const f = extensionEntryFixture({ keptNotice: '迁移数据目录没有进行：另一个窗口先发起了合并旧聊天记录' });
  t.after(async () => {
    f.opened.resolve(f.application);
    f.finishUpgrade.resolve();
    await f.deactivate();
  });
  const beforeActivation = Date.now();
  f.activate(f.context);
  const activated = Date.now();
  const ready = f.startup.wait();
  await f.opening.promise;
  // The reopened window waits for the maintenance that reloaded it before its Runtime opens.
  await new Promise(done => setTimeout(done, 50));
  f.opened.resolve(f.application);
  await ready;
  for (let i = 0; i < 20 && !f.events.some(event => Array.isArray(event) && event[0] === 'kept-notice-read'); i += 1) {
    await new Promise(setImmediate);
  }
  const [, openedAt] = f.events.find(event => Array.isArray(event) && event[0] === 'kept-notice-read');
  assert.ok(typeof openedAt === 'number' && openedAt >= beforeActivation && openedAt <= activated, `activation start, not now (${openedAt})`);
  assert.deepEqual(f.events.filter(event => Array.isArray(event) && event[0] === 'warning-message'),
    [['warning-message', 'Fixture 重载前：迁移数据目录没有进行：另一个窗口先发起了合并旧聊天记录']]);
});

test('a wait on the Runtime is settled once its lock was taken: the notification closes and the shell stops saying it waits, before the Runtime finished opening (blind review #9)', async t => {
  const f = extensionEntryFixture();
  t.after(async () => {
    f.opened.resolve(f.application);
    f.finishUpgrade.resolve();
    await f.deactivate();
  });
  f.activate(f.context);
  const ready = f.startup.wait();
  await f.opening.promise;
  const [{ onRuntimeWait, onRuntimeWaitOver }] = f.openOptions;
  onRuntimeWait({ waitedMs: 1_500, holderWaitedMs: 1_500, activity: {
    operation: 'data-root-migration', description: '迁移数据目录', stage: '正在切换到新数据目录', runningMs: 9_000, heartbeatAgeMs: 500, stale: false
  } });
  await new Promise(setImmediate);
  assert.match(f.startup.waiting()?.description ?? '', /另一个窗口正在迁移数据目录/);
  onRuntimeWaitOver();
  for (let i = 0; i < 5; i += 1) await new Promise(setImmediate);
  assert.equal(f.startup.waiting(), undefined, 'the shell no longer says it waits while the Runtime opens');
  assert.deepEqual(f.events.filter(event => Array.isArray(event) && event[0].startsWith('opening-notification')),
    [['opening-notification', 'LimCode 正在等待另一个窗口'], ['opening-notification-closed']], 'closed before the Runtime opened');
  f.opened.resolve(f.application);
  await ready;
});

test('before another window reloads this one, every panel is asked through the Facade to save its unsent input at once (blind review #10)', async t => {
  const f = extensionEntryFixture();
  t.after(async () => {
    f.opened.resolve(f.application);
    f.finishUpgrade.resolve();
    await f.deactivate();
  });
  f.activate(f.context);
  const ready = f.startup.wait();
  await f.opening.promise;
  f.opened.resolve(f.application);
  await ready;
  for (let i = 0; i < 20 && f.participantOptions.length === 0; i += 1) await new Promise(setImmediate);
  assert.equal(f.participantOptions[0].saveDrafts(), 1);
  assert.deepEqual(f.events.filter(event => event === 'save-drafts' || (Array.isArray(event) && event[0] === 'post-to-webview')),
    ['save-drafts', ['post-to-webview', 'panel-client', 'composer.draft.save']]);
});

test('deactivation marks this window leaving at once and removes its registration only after its Runtime closed (blind review #1)', async t => {
  for (const closes of [true, false]) {
    const f = extensionEntryFixture();
    t.after(() => f.finishUpgrade.resolve());
    f.activate(f.context);
    const ready = f.startup.wait();
    await f.opening.promise;
    f.opened.resolve(f.application);
    await ready;
    for (let i = 0; i < 5 && !f.events.some(event => Array.isArray(event) && event[0] === 'participant-start'); i += 1) {
      await new Promise(setImmediate);
    }
    const closing = deferred();
    f.application.dispose = async () => {
      f.events.push('dispose');
      await closing.promise;
      if (!closes) throw new Error('fixture close failed');
      f.events.push('disposed');
    };
    f.finishUpgrade.resolve();
    const shutdown = f.deactivate();
    for (let i = 0; i < 5; i += 1) await new Promise(setImmediate);
    assert.ok(f.events.includes('participant-dispose'), 'leaving is marked at once');
    assert.equal(f.events.includes('participant-unregister'), false, 'the registration stays while the Runtime closes');
    closing.resolve();
    if (closes) {
      await shutdown;
      assert.ok(f.events.indexOf('participant-unregister') > f.events.indexOf('disposed'));
    } else {
      await assert.rejects(shutdown, /fixture close failed/);
      assert.equal(f.events.includes('participant-unregister'), false, 'a Runtime that failed to close stays registered as leaving');
    }
  }
});
