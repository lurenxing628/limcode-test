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
const { RUNTIME_KERNEL_EPOCH } = require(path.join(compiled, 'backend/reliableKernel/contracts.js'));


function emptyMergeReport(overrides = {}) {
  return { merged: [], deferred: [], blocked: [], failures: [], pendingSources: 0, stopped: false, ...overrides };
}

/** The window's open Runtime that receives online merges. */
const mergeHost = () => ({ product: { application: { database: { hostBootId: 'this-window' } } } });

function fixture({
  picks = [], confirmation, application, currentEpoch = RUNTIME_KERNEL_EPOCH, oldEpoch = RUNTIME_KERNEL_EPOCH,
  problems = [], upgradeError, informationChoice, changedAfterUpgrade = false,
  batchReport = { results: [], failures: [] }, batchHook, upgradeHook,
  mergeReport = emptyMergeReport(), mergeStates = {}, mergeError, mergeHook, exclusiveOutcome = 'completed', summaries = {}, globalState,
  repairPlan, repairHook, emptyOld = false, lifetime = loadSource('vscode/runtimeDataSetUpgradeLifetime.ts', {}), largeWaiting = [], workspaceState, undecidedClaim = true
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
    './runtimeHistoryConvergence': { isHistoryConvergenceHost: host => !!host?.large, convergeRuntimeHistory: async (_context,_host,ids) => calls.push(['converge', [...ids]]) },
    vscode,
    '../../backend/reliableKernel/runtimeHistoryRepair': {
      inspectRuntimeHistoryRepair: async (_paths, input) => {
        calls.push(['repair-inspect', input]);
        return repairPlan ?? { expected: { orphanOperations: 2, orphanAttempts: 2, restoredUnknownProcesses: 1, refused: 0, samples: [] }, previous: [] };
      },
      repairRuntimeHistory: async (_paths, plan) => {
        calls.push(['repair-write', plan]);
        if (repairHook) await repairHook(plan);
        return { result: { removedOperations: 2, removedAttempts: 2, restoredUnknownProcesses: 1 }, backupPath: '/fixture/repair-backup', warnings: [] };
      }
    },
    '../../backend/reliableKernel/runtimeHistoryRepairInspection': { historyRepairCount: (facts) => facts.orphanOperations + facts.restoredUnknownProcesses },
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
        candidate.runtimeKernelEpoch = RUNTIME_KERNEL_EPOCH;
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
      // The prompt record about data sets switched away from in an earlier version, and the answer “保持分开”.
      claimRuntimeDataSetUndecidedPrompt: async (_paths, input) => { calls.push(['undecided-claim', input.sessionId]); return undecidedClaim; },
      keepRuntimeDataSetsApart: async (_paths, ids) => { calls.push(['keep-apart', [...ids]]); },
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
      requesterWorkBusy: host => async () => await host.hasOwnedExecution() ? { kind: 'work', reason: '任务进行中' } : undefined,
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

    '../../backend/application/reliableKernel/historicalMergeSettlement': { settleHistoricalMergeSourceOffline: async () => ({ unsettled: [], live: [] }) },
    './runtimeHistorySettlement': { confirmRuntimeHistorySettlement: async () => true },
    './runtimeHistoryResiduals': { manageRuntimeHistoryResiduals: async () => {} },
    '../../backend/reliableKernel/runtimeHistoryConvergence': { registerRuntimeHistoryConvergence: async () => 0 },
    '../../backend/reliableKernel/runtimeHistoryRegistry': { readRuntimeHistoryPending: async () => new Map() },
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

test('历史管理不再提供切换当前历史', async () => {
  const f = fixture();
  await f.manageRuntimeDataSets(f.context, f.startup);
  const items = f.calls.find(call => call[0] === 'pick')[1];
  assert.equal(items.some(item => item.action === 'select'), false);
  assert.equal(f.calls.some(call => ['select', 'command'].includes(call[0])), false);
});

const brokenSource = { id: 'workspace:broken', runtimeScopeRootPath: '/fixture/broken', message: '历史库缺少完整文件' };

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
  assert.match(info, /已把 1 份旧聊天记录合并到当前历史（新增 3 个对话）/);
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
  for (const [requested, outcome] of [[true, 'busy'], [true, 'completed']]) {
    let merged = false;
    let result;
    const f = fixture({ exclusiveOutcome: outcome, mergeHook: async options => {
      result = await options.coordinateOversized(oversized(requested), async () => { merged = true; });
    } });
    await f.mergeHistoricalDataSetsInBackground(f.context, mergeHost(), () => true, ['workspace:old']);
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
    '已把 1 份旧聊天记录合并到当前历史（新增 1 个对话），可直接在侧栏继续。另有 2 条排队未发送的消息已取消。原库和合并前备份都已保留。'
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
    '已把 1 份旧聊天记录合并到当前历史（新增 1 个对话），可直接在侧栏继续。有 3 个对话你删除过，这次没有合并回来。'
    + '原库和合并前备份都已保留。'
  ]);
  assert.deepEqual(f.logs.filter(([level]) => level === 'info').map(([, line]) => line), [
    '[LimCode] 已合并旧聊天记录 workspace:old：新增 12 行；合并前备份：/fixture/backup；3 个你删除过的对话没有再合并'
  ]);
});

test('外来历史库合并：通知与日志用可读名称，并提示这份归档或拷来的库可以在“清理备份”里按覆盖核对删除；没有新内容时同样提示；原因列表也用名称', async () => {
  const id = 'foreign:archive:0123456789abcdef';
  const label = '外来历史库（归档 · 20260901-010203-004-abcdef12）';
  const tip = `${label}原样保留；确认不再需要时，可以在“清理备份”里按覆盖核对后删除。`;
  const merged = fixture({ mergeReport: emptyMergeReport({ merged: [mergedOld({ candidateId: id, label, copiedCasObjects: 3 })] }) });
  await merged.mergeHistoricalDataSetsInBackground(merged.context, mergeHost(), () => true, [id]);
  assert.deepEqual(merged.calls.filter(call => call[0] === 'info').map(call => call[1]), [
    `已把 1 份旧聊天记录合并到当前历史（新增 1 个对话），可直接在侧栏继续。原库和合并前备份都已保留。${tip}`
  ]);
  assert.deepEqual(merged.logs.filter(([level]) => level === 'info').map(([, line]) => line), [
    `[LimCode] 已合并旧聊天记录 ${label}（${id}）：新增 12 行；合并前备份：/fixture/backup`
  ]);
  const again = fixture({ mergeReport: emptyMergeReport({ merged: [mergedOld({
    candidateId: id, label, alreadyMerged: true, insertedRows: 0, insertedConversations: 0, backupPath: undefined
  })] }) });
  await again.mergeHistoricalDataSetsInBackground(again.context, mergeHost(), () => true, [id]);
  assert.deepEqual(again.calls.filter(call => call[0] === 'info').map(call => call[1]), [`旧数据已合并到当前历史，没有新内容。${tip}`]);
  const local = fixture({ mergeReport: emptyMergeReport({ merged: [mergedOld()] }) });
  await local.mergeHistoricalDataSetsInBackground(local.context, mergeHost(), () => true);
  assert.doesNotMatch(local.calls.find(call => call[0] === 'info')[1], /清理备份/, '本地历史库的合并不提清理备份');
  // Conversations the user had deleted were left out: backup cleanup keeps this copy, so the tip says so instead.
  const skipped = fixture({ mergeReport: emptyMergeReport({ merged: [mergedOld({ candidateId: id, label, skippedConversations: 2 })] }) });
  await skipped.mergeHistoricalDataSetsInBackground(skipped.context, mergeHost(), () => true, [id]);
  const notice = skipped.calls.find(call => call[0] === 'info')[1];
  assert.ok(notice.endsWith(`${label}合并时跳过了 2 个你删除过的对话，它们只在这份里还有，所以“清理备份”会保留这份；确实不再需要时请手动删除。`), notice);
  assert.ok(!notice.includes('可以在“清理备份”里按覆盖核对后删除'), '不再说可以按覆盖删除');

  const refused = fixture({ confirmation: '查看原因', mergeReport: emptyMergeReport({ blocked: [{
    candidateId: id, label, code: 'runtime-data-set-merge-foreign-old-copy', message: '这个外来历史库是当前历史的旧拷贝。', newly: true, requested: true
  }] }) });
  await refused.mergeHistoricalDataSetsInBackground(refused.context, mergeHost(), () => true, [id]);
  for (let turn = 0; turn < 50 && !refused.calls.some(call => call[0] === 'document'); turn += 1) await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(refused.calls.find(call => call[0] === 'document'), ['document',
    `${label}\n[runtime-data-set-merge-foreign-old-copy] 这个外来历史库是当前历史的旧拷贝。`]);
});

test('盲审 merge #4：明确合并时已合并、没有新内容也有回应，引擎什么都没做时同样回应；自动合并没有可说的就静默', async () => {
  const already = {
    candidateId: 'workspace:old', sourceDataSetId: 'old', targetDataSetId: 'current', insertedRows: 0, reusedRows: 0,
    insertedConversations: 0, linkedCasObjects: 0, copiedCasObjects: 0, reusedCasObjects: 0, recoveredCommit: false, alreadyMerged: true
  };
  const explicit = async mergeReport => {
    const f = fixture({ mergeReport });
    await f.mergeHistoricalDataSetsInBackground(f.context, mergeHost(), () => true, undefined, true);
    return f.calls.filter(call => ['info', 'warning', 'error'].includes(call[0]) && call[1] !== '把这个历史库合并到当前库？').map(call => call[1]);
  };
  assert.deepEqual(await explicit(emptyMergeReport({ merged: [already] })), ['旧数据已合并到当前历史，没有新内容。']);
  assert.deepEqual(await explicit(emptyMergeReport({ merged: [{ ...already, mergedByAnotherWindow: true }] })), ['旧数据已由另一个窗口合并到当前历史。'],
    '盲审2 #7：另一个窗口刚合并了它，不说“没有新内容”');
  assert.deepEqual(await explicit(emptyMergeReport()), ['这次没有需要合并的旧数据。']);
  assert.deepEqual(await explicit(emptyMergeReport({ stopped: true })), [], '停止（窗口关闭或切库）时不回应');

  const quiet = fixture({ mergeReport: emptyMergeReport() });
  await quiet.mergeHistoricalDataSetsInBackground(quiet.context, mergeHost());
  assert.equal(quiet.calls.some(call => ['info', 'warning'].includes(call[0])), false);
  const closed = fixture({ mergeReport: emptyMergeReport({ merged: [{ ...already, finalized: { turns: 1, intents: 0, sourceBackupPath: '/fixture/source-backup' } }] }) });
  await closed.mergeHistoricalDataSetsInBackground(closed.context, mergeHost());
  assert.deepEqual(closed.calls.filter(call => call[0] === 'info').map(call => call[1]),
    ['1 份旧聊天记录已合并到当前历史，没有新内容。其中 1 个中断的任务已按“中止”收尾，不会被继续执行。'], '收尾过的工作照样说明');
});

test('跨模块盲审 #7：磁盘空间不足的推迟只在新原因出现时提示，所需空间的数字变了也不重复提示', async () => {
  const values = new Map();
  const globalState = { get: key => values.get(key), update: async (key, value) => { values.set(key, value); } };
  const full = megabytes => ({ candidateId: 'workspace:old', code: 'runtime-data-set-merge-disk-full', newly: true,
    message: `磁盘空间不足，需要约 ${megabytes} MB：合并前要先在 /fixture/current 备份当前历史` });
  const notices = async issue => {
    const f = fixture({ globalState, mergeReport: emptyMergeReport({ deferred: [issue] }) });
    await f.mergeHistoricalDataSetsInBackground(f.context, mergeHost());
    return f.calls.filter(call => ['warning', 'info'].includes(call[0])).map(call => call[1]);
  };
  assert.deepEqual(await notices(full(120)),
    ['有 1 份旧聊天记录暂时无法合并（磁盘空间不足，需要约 120 MB：合并前要先在 /fixture/current 备份当前历史），以后启动时会自动重试。']);
  assert.deepEqual(await notices(full(121)), [], '之后每次启动同一原因都不再提示');
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

test('最后一轮盲审 #2：从设置页发起的迁移数据目录从开始到结束（确认、可能要几分钟的准备、协调、撤销）都登记为本窗口正在进行的维护；命令面板只打开设置页时不登记', async () => {
  const handlers = new Map();
  const events = [];
  const ids = new Proxy({}, { get: (_target, name) => String(name) });
  const host = { exclusiveMaintenanceTarget: () => ({ paths: {}, hostBootId: 'window-a' }) };
  const commands = loadSource('vscode/commands/registerCommands.ts', {
    vscode: {
      commands: { registerCommand: (id, handler) => { handlers.set(id, handler); return { dispose() {} }; } },
      window: { async showErrorMessage(message) { events.push(['error', message]); } }
    },
    '../panels/MainPanel': { MainPanel: {} },
    '../../shared/extensionIdentity': { EXTENSION_BRAND: 'Limcode test', EXTENSION_COMMAND_IDS: ids },
    './dataRootRelocation': { async relocateDataRoot(_context, _startup, request) { events.push(['relocate', request?.clientId ?? null]); } },
    '../runtimeExclusiveMaintenance': {
      holdOwnExclusiveMaintenanceWork(holdHost, work) {
        assert.equal(holdHost, host);
        events.push(['hold', work.operation, work.activity]);
        return () => events.push(['release']);
      }
    }
  }, { Promise });
  commands.registerCommands({ subscriptions: [] }, { current: () => host });
  await handlers.get('relocateDataRoot')({ clientId: 'settings-client' });
  assert.deepEqual(events, [['hold', 'data-root-relocation', '迁移数据目录'], ['relocate', 'settings-client'], ['release']]);
  events.length = 0;
  await handlers.get('relocateDataRoot')();
  assert.deepEqual(events, [['relocate', null]], 'only opens the settings page: nothing held');
});

/** Lets the module's detached work (a question not awaited) run until `done` holds. */
async function settle(done) {
  for (let turn = 0; turn < 200 && !done(); turn += 1) await new Promise(resolve => setImmediate(resolve));
}

 test('当前历史先协调离线再检查修复，完成后重载且不改选', async () => {
  const events = [];
  const application = {
    large: true, product: { application: { database: {} } },
    dataRootPath: () => '/fixture', hasOwnedExecution: async () => false,
    exclusiveMaintenanceTarget: () => ({ paths: { dataRootPath: '/fixture/current' }, hostBootId: 'host' }),
    withDataRootLocks: body => body(), freezeNewWork: () => () => {},
    closeRuntime: async () => { events.push('closed'); }
  };
  const f = fixture({ picks: [action('repair'), 0], application, confirmation: ['离线检查', '备份并修复'],
    repairHook: async () => assert.deepEqual(events, ['closed']) });
  await f.manageRuntimeDataSets(f.context, f.startup);
  assert.equal(f.calls.filter(call => call[0] === 'exclusive').length, 1);
  assert.equal(f.calls.filter(call => call[0] === 'repair-write').length, 1);
  assert.deepEqual(f.calls.filter(call => call[0] === 'command'), [['command', 'workbench.action.reloadWindow']]);
  assert.equal(f.calls.some(call => call[0] === 'select'), false);
});

 test('单一历史菜单没有选库、保留、外来列表、删除来源或旧会话入口', async () => {
  const f = fixture(); await f.manageRuntimeDataSets(f.context,f.startup);
  const items=f.calls.find(call=>call[0]==='pick')[1];
  assert.deepEqual(plain(items.map(item=>item.action)),['residual','mergeAll','storage','repair','relocate','cleanupBackups','reset']);
  assert.equal(f.calls.some(call=>['select','delete','merge-request','large-waiting'].includes(call[0])),false);
});
 test('启动直接打开固定当前历史，失败如实传播而不再要求选库', async () => {
  const f=fixture(); const error=new Error('cannot open');
  await assert.rejects(f.openWithRuntimeDataSetSelection(f.context,async()=>{throw error;}),e=>e===error);
  assert.equal(f.calls.some(call=>['pick','select'].includes(call[0])),false);
});

for (const mode of ['success','cancelled-preparation','merge-failed']) test(`直接合并入口 ${mode}：释放准备、取消不关闭、关闭后重载`, async () => {
  const events=[];
  const context={workspaceState:{}};
  const host={product:{application:{database:{}}},hasOwnedExecution:async()=>false,
    exclusiveMaintenanceTarget:()=>({paths:{dataRootPath:'/current'},hostBootId:'host'}),dataRootPath:()=>'/fixture',
    withDataRootLocks:async body=>body(),freezeNewWork:()=>()=>events.push('thaw'),closeRuntime:async()=>events.push('close'),
    writeGate:{admit(){events.push('admit');}}};
  const prepared={target:{dataSetId:'target',rootInstanceId:'instance'},
    sources:mode==='cancelled-preparation'?[]:[{candidateId:'old'}],report:emptyMergeReport({stopped:mode==='cancelled-preparation'})};
  const dependencies={
    vscode:{ProgressLocation:{Notification:1},window:{showInformationMessage:async()=>{},showWarningMessage:async()=>{},
      withProgress:async(_options,body)=>body({report(){}},{onCancellationRequested:()=>({dispose(){}})})},
      commands:{executeCommand:async name=>events.push(name)}},
    '../../backend/application/reliableKernel/historicalMergeSettlement':{settleHistoricalMergeSourceOffline:async()=>{}},
    '../../backend/reliableKernel/runtimeDataSetStreamedMerge':{
      prepareLargeMergeSources:async()=>{events.push('prepare');return prepared;},
      releaseLargeMergePreparation:async()=>events.push('release'),
      runLargeMergeSession:async()=>{events.push('merge');if(mode==='merge-failed')throw new Error('merge failed');return {results:[],cancelled:false};}},
    '../panels/MainPanel':{MainPanel:{saveComposerDrafts:()=>0}},
    '../runtimeDataSetUpgradeLifetime':{canStartRuntimeDataSetUpgrade:()=>true,runRuntimeDataSetUpgrade:async(_c,body)=>body()},
    '../runtimeExclusiveMaintenance':{holdOwnExclusiveMaintenanceWork:()=>()=>events.push('release-hold'),
      requesterWorkBusy:()=>async()=>undefined,runWithExclusiveMaintenance:async(_paths,options,body)=>{
        events.push('coordinate');const admission=await options.beforeGo();
        try{return {state:'completed',result:await options.withLocks(()=>body({reportStage(){}}))};}finally{admission.thaw?.();}}},
    './runtimeHistorySettlement':{confirmRuntimeHistorySettlement:async()=>true}
  };
  const module=loadSource('vscode/commands/runtimeHistoryConvergence.ts',dependencies,{AbortController,setInterval,clearInterval,setTimeout});
  const run=module.convergeRuntimeHistory(context,host,['old'],async()=>events.push('report'));
  if(mode==='merge-failed')await assert.rejects(run,/merge failed/);else await run;
  assert.equal(events.filter(e=>e==='release').length,1);
  assert.equal(events.filter(e=>e==='release-hold').length,1);
  assert.equal(events.includes('close'),mode!=='cancelled-preparation');
  assert.equal(events.includes('workbench.action.reloadWindow'),mode!=='cancelled-preparation');
  if(mode==='success')assert.ok(events.indexOf('close')<events.indexOf('merge'));
});
