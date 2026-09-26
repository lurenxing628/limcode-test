const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const test = require('node:test');
const ts = require('typescript');

const action = name => items => items.find(item => item.action === name);

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

function fixture({
  picks = [], confirmation, application, currentEpoch = 5, oldEpoch = 5,
  problems = [], upgradeError, informationChoice, changedAfterUpgrade = false,
  batchReport = { results: [], failures: [] }, batchHook, upgradeHook,
  lifetime = loadSource('vscode/runtimeDataSetUpgradeLifetime.ts', {})
} = {}) {
  const current = { id: 'default', dataSetId: 'current', rootInstanceId: 'current-instance', runtimeKernelEpoch: currentEpoch, selected: true, runtimeDataRootPath: '/fixture/current' };
  const old = { id: 'workspace:old', dataSetId: 'old', rootInstanceId: 'old-instance', runtimeKernelEpoch: oldEpoch, selected: false, runtimeDataRootPath: '/fixture/old' };
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
    '../../backend/reliableKernel/runtimeDataSetHistory': {
      openRuntimeDataSetHistory: async (_paths, id) => {
        calls.push(['history', id]);
        return {
          listConversations: async () => ({ items: [{ id: 'conversation', title: 'Original history', updatedAt: '2026-01-01' }] }),
          readMessages: async () => ({ items: [{ id: 'message', role: 'user', text: 'preserved text', createdAt: '2026-01-01' }] }),
          close: async () => calls.push(['close'])
        };
      }
    },
    '../../backend/reliableKernel/runtimeStorageInspection': {
      deleteUnselectedRuntimeDataSet: async (_paths, id, expected) => calls.push(['delete', id, expected])
    },
    '../../shared/extensionIdentity': { EXTENSION_COMMAND_IDS: { resetDevelopmentData: 'reset' } },
    '../runtimeDataSetUpgradeLifetime': lifetime
  };
  const filename = path.resolve(__dirname, '../../vscode/commands/runtimeDataSetManagement.ts');
  const module = { exports: {} };
  vm.runInNewContext(ts.transpileModule(fs.readFileSync(filename, 'utf8'), {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS }
  }).outputText, { module, exports: module.exports, require: name => dependencies[name] ?? require(name) });
  return { ...module.exports, context: { subscriptions: [] }, startup: { current: () => application }, calls, SelectionRequired, lifetime };
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
function extensionEntryFixture({ onDemand = false, upgradeError } = {}) {
  const events = [];
  const opening = deferred();
  const opened = deferred();
  const upgradeStarted = deferred();
  const finishUpgrade = deferred();
  let startup;
  const application = {
    async dispose() { events.push('dispose'); },
    async startRuntimeRecovery() { events.push('recover'); }
  };
  const lifetime = loadSource('vscode/runtimeDataSetUpgradeLifetime.ts', {});
  const management = fixture({ lifetime, upgradeError,
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
    vscode: { window: { async showErrorMessage(message) { events.push(['error', message]); } } },
    './commands/registerCommands': { registerCommands(_context, barrier) { startup = barrier; } },
    './panels/MainPanel': { MainPanel: { registerSerializer() {} } },
    './views/SidebarEntryView': { registerSidebarEntryView() {} },
    './ApplicationStartup': loadSource('vscode/ApplicationStartup.ts', {}),
    './runtimeDataSetUpgradeLifetime': lifetime,
    '../shared/extensionIdentity': { EXTENSION_BRAND: 'Fixture' },
    '../backend/application/reliableKernel/VscodeReliableKernelApplicationFacade': {
      VscodeReliableKernelApplicationFacade: { open() {
        events.push('open');
        opening.resolve();
        return opened.promise;
      } }
    },
    './commands/runtimeDataSetManagement': management,
    './watchers/GlobalSettingsWatcher': { registerGlobalSettingsWatcher() {} },
    '../backend/application/runtimeBuildInfo': { RUNTIME_BUILD_INFO: {} }
  }, {
    setImmediate,
    console: { log() {}, warn(...args) { events.push(['warning', ...args]); }, error(...args) { events.push(['error', ...args]); } }
  });
  return {
    ...extension, application, context: management.context, calls: management.calls, events, management, lifetime,
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
