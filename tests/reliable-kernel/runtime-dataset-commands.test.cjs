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
  lifetime = loadSource('vscode/runtimeDataSetUpgradeLifetime.ts', {})
} = {}) {
  const current = { id: 'default', dataSetId: 'current', rootInstanceId: 'current-instance', runtimeKernelEpoch: currentEpoch, selected: true, runtimeDataRootPath: '/fixture/current', source: 'legacy' };
  const old = { id: 'workspace:old', dataSetId: 'old', rootInstanceId: 'old-instance', runtimeKernelEpoch: oldEpoch, selected: false, runtimeDataRootPath: '/fixture/old', source: 'workspace' };
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
      requestRuntimeDataSetMerge: async (_paths, input) => {
        calls.push(['merge-request', input.candidateId, input.expectedDataSetId, input.expectedRootInstanceId]);
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
    '../../backend/reliableKernel/runtimeDataSetPreflight': {
      summarizeRuntimeDataSet: async candidate => {
        calls.push(['summarize', candidate.id]);
        if (summaries[candidate.id] instanceof Error) throw summaries[candidate.id];
        return summaries[candidate.id];
      }
    },
    '../../backend/reliableKernel/runtimeStorageInspection': {
      deleteUnselectedRuntimeDataSet: async (_paths, id, expected) => calls.push(['delete', id, expected])
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
    }
  };
  const filename = path.resolve(__dirname, '../../vscode/commands/runtimeDataSetManagement.ts');
  const module = { exports: {} };
  vm.runInNewContext(ts.transpileModule(fs.readFileSync(filename, 'utf8'), {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS }
  }).outputText, { module, exports: module.exports, require: name => dependencies[name] ?? require(name) });
  return { ...module.exports, context: { subscriptions: [], ...(globalState ? { globalState } : {}) }, startup: { current: () => application }, calls, SelectionRequired, lifetime };
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
function extensionEntryFixture({ onDemand = false, upgradeError, mergeHook } = {}) {
  const events = [];
  const openOptions = [];
  const opening = deferred();
  const opened = deferred();
  const upgradeStarted = deferred();
  const finishUpgrade = deferred();
  let startup;
  const application = {
    ...mergeHost(),
    async dispose() { events.push('dispose'); },
    async startRuntimeRecovery() { events.push('recover'); }
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
    vscode: { window: { async showErrorMessage(message) { events.push(['error', message]); } } },
    './commands/registerCommands': { registerCommands(_context, barrier) { startup = barrier; } },
    './panels/MainPanel': { MainPanel: { registerSerializer() {} } },
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
    './watchers/GlobalSettingsWatcher': { registerGlobalSettingsWatcher() {} },
    './runtimeExclusiveMaintenance': {
      startExclusiveMaintenanceParticipant(host, options) {
        events.push(['participant-start', host === application, options.isCurrent()]);
        return { async dispose() { events.push('participant-dispose'); } };
      }
    },
    '../backend/application/runtimeBuildInfo': { RUNTIME_BUILD_INFO: {} }
  }, {
    setImmediate,
    console: { log() {}, warn(...args) { events.push(['warning', ...args]); }, error(...args) { events.push(['error', ...args]); } }
  });
  return {
    ...extension, application, context: management.context, calls: management.calls, events, management, lifetime, openOptions,
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
  assert.match(info, /2 个旧版本中断的任务已按“中止”收尾，不会被继续执行/);
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
    /未能合并到当前库，这些库里的内容没有被改动（已发布的旧格式会先备份并就地升级）/);
  const deferredIssue = { candidateId: 'workspace:old', code: 'runtime-hosts-active', message: '这个历史库正被其它窗口使用', newly: true };
  const deferred = fixture({ mergeReport: emptyMergeReport({ deferred: [deferredIssue] }) });
  await deferred.mergeHistoricalDataSetsInBackground(deferred.context, mergeHost());
  assert.match(deferred.calls.find(call => call[0] === 'info')[1], /1 份旧聊天记录暂时无法合并（这个历史库正被其它窗口使用），以后启动时会自动重试/);
  const failing = fixture({ mergeError: Object.assign(new Error('磁盘已满'), { code: 'ENOSPC' }) });
  await failing.mergeHistoricalDataSetsInBackground(failing.context, mergeHost());
  assert.match(failing.calls.find(call => call[0] === 'warning')[1], /暂时无法合并.*磁盘已满/);
  const obsolete = fixture();
  await obsolete.mergeHistoricalDataSetsInBackground(obsolete.context, mergeHost(), () => false);
  assert.equal(obsolete.calls.some(call => call[0] === 'merge-online'), false);
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
  assert.match(confirm[2].detail, /按“中止”收尾，不会在当前库被继续执行/);
  assert.match(confirm[2].detail, /若有其它窗口正在执行任务或正在使用，这次先不合并，之后会再试/);
  assert.doesNotMatch(confirm[2].detail, /会先等它们的任务结束/, '合并时不等待忙窗口');
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
  assert.match(detail, /只新建过对话时，新对话会合并进来.*在已合并的对话里继续过时.*整体不合并/);
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
  assert.equal(f.calls.some(call => ['select', 'command'].includes(call[0])), false, '未确认不切换');
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
  assert.equal(f.openOptions[0], undefined, 'Runtime open 不再带启动前合并钩子');
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
