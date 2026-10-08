// One VS Code window of the new version as its own process, for large-historical-merge-e2e.test.mjs.
// It opens the full production Runtime composition (runtime-dataset-merge-full-runtime.mjs: only the
// model Provider is synthetic, and every call to it is recorded) under the configuration admission
// like extension.ts, sweeps what interrupted operations left (dataRootRelocation.afterDataRootOpened),
// takes part in exclusive maintenance (vscode/runtimeExclusiveMaintenance.ts) and then runs the real
// startup flow of vscode/commands/runtimeDataSetManagement.ts: the result of a large merge session kept
// across the reload, the background merge and, for the sources it leaves to it, the large merge session
// of vscode/commands/largeHistoricalMerge.ts with the real engine (runtimeLargeMergeEngine.ts →
// runtimeDataSetStreamedMerge.ts) and the real disk check. Only the startup prompt's countdown (1 s)
// and the coordination's poll interval are shortened. The data directory is not relocated, so its two
// path helpers return the configuration root. The vscode UI is a mock that writes every notification
// as a JSON line to stdout. A reload closes the Runtime and exits; the test starts the next boot.
// Behaviors:
//   windowStateFile / globalStateFile — this window's workspaceState / the extension's globalState (files)
//   countdownSeconds           — the startup prompt's countdown (1 by default)
//   cancelCountdown            — the user presses “取消” as soon as the startup prompt appears
//   closeWhenPostponed         — once the prompt says it moved to the next startup, this window closes
//                                (after the startup recovery settled): the next boot is the next startup
//   manual: 'menu' / 'all'     — after startup, choose 立即合并全部 in the menu or invoke its command;
//                                sources are prepared directly, with settlement consent when needed.
//   closeAfterBatch            — close without choosing a merge; large sources stay pending.
//   lookAtMenu                 — the user only opens 历史与存储管理 and looks at the items
//   cancelPreparationAt        — the user presses “取消” on the preparation's notification once a report
//                                matches this pattern
//   killAt { index, merging }  — this process is SIGKILLed at the `merging`-th progress report of the
//                                merge stage of the session's source `index` (the transaction is open)
//   cancelAt { index, merging } — there the user presses “取消” on the session's progress notification
//   settle                     — after the startup recovery: waits settleMs (2500 by default) and until the
//                                runner is idle, then reports the Provider calls of this boot
//   reloadWhenSettled / closeWhenSettled — then reloads (the next boot opens the library again) / closes
import fsSync from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const Module = require('node:module');
// The composition first: its storage modules keep its vscode mock (Uri, workspace.fs).
const { openFullRuntime } = await import('./runtime-dataset-merge-full-runtime.mjs');
const baseVscode = require('vscode');
class Uri extends baseVscode.Uri {
  static parse(text) { return { toString: () => text }; }
}
// The Facade module (only its prototype methods are used) also needs these at load time.
const facadeVscode = { ...baseVscode, Uri, EventEmitter: class { event = () => ({ dispose() {} }); fire() {} dispose() {} } };
const previousLoad = Module._load;
Module._load = function load(request, parent, isMain) {
  return request === 'vscode' ? facadeVscode : previousLoad.call(this, request, parent, isMain);
};
const compiled = path.resolve(process.env.LIMCODE_TEST_EXTENSION_ROOT ?? 'dist/extension');
const kernelFile = (file) => require(path.join(compiled, 'backend/reliableKernel', file));
const { RootAuthority } = kernelFile('rootAuthority.js');
const { resolveVscodeRuntimeDataRoot } = kernelFile('vscodeRootAuthority.js');
const { openUnderCurrentDataRootAdmission, withRuntimeDataRootAdmission, withRuntimeMaintenance } = kernelFile('runtimeHostControl.js');
const { sweepDataRootRelocationLeftovers } = kernelFile('runtimeDataRootRelocation.js');
const exclusiveBackend = kernelFile('runtimeExclusiveMaintenance.js');
const engineModule = kernelFile('runtimeLargeMergeEngine.js');
const largeMergeSession = kernelFile('runtimeLargeMergeSession.js');
const extensionIdentity = require(path.join(compiled, 'shared/extensionIdentity.js'));
const { VscodeReliableKernelApplicationFacade: Facade } = require(path.join(
  compiled, 'backend/application/reliableKernel/VscodeReliableKernelApplicationFacade.js'
));
const { RuntimeWriteGate } = require(path.join(compiled, 'backend/application/reliableKernel/runtimeWriteGate.js'));

const { root, settingsRoot, name, boot, behavior } = JSON.parse(process.env.LIMCODE_LARGE_MERGE_WINDOW);
const activationStartedAt = Date.now();
/** Synchronous (also right before a SIGKILL): one JSON line per event. */
const emit = (event, extra = {}) => {
  fsSync.writeSync(1, `${JSON.stringify({ name, boot, event, at: Date.now(), ...extra })}\n`);
};
setInterval(() => {}, 60_000);
process.on('unhandledRejection', (error) => emit('unhandled', { reason: String(error?.stack ?? error) }));

function fileMemento(file) {
  const read = () => (file && fsSync.existsSync(file) ? JSON.parse(fsSync.readFileSync(file, 'utf8')) : {});
  return {
    get: (key, fallback) => (Object.prototype.hasOwnProperty.call(read(), key) ? read()[key] : fallback),
    keys: () => Object.keys(read()),
    update: async (key, value) => {
      if (!file) return;
      const all = read();
      if (value === undefined) delete all[key];
      else all[key] = value;
      fsSync.writeFileSync(file, JSON.stringify(all));
    }
  };
}
const windowState = fileMemento(behavior.windowStateFile);
const globalState = fileMemento(behavior.globalStateFile);

// The untitled cancellable notification that runs now: the startup prompt, later the session's progress.
let activeCancellable;
let deactivated = false;
const vscodeMock = {
  ProgressLocation: { Notification: 15, Window: 10 },
  env: { sessionId: `session-${name}-${boot}` },
  window: {
    state: { focused: false },
    async withProgress(options, task) {
      const title = options.title;
      emit('progress', { title, location: options.location, cancellable: options.cancellable === true });
      const cancellation = { requested: false, listeners: new Set() };
      const handle = {
        cancel() {
          if (cancellation.requested) return;
          cancellation.requested = true;
          for (const listener of [...cancellation.listeners]) listener();
        }
      };
      if (options.cancellable === true && title === undefined) activeCancellable = handle;
      try {
        return await task({
          report(value) {
            if (!value?.message) return;
            emit('progress-report', { title, message: value.message });
            // The user postpones the startup prompt as soon as it counts down.
            if (behavior.cancelCountdown && /^将在 \d+ 秒后合并/.test(value.message)) handle.cancel();
            // The user stops the manual preparation part way.
            if (behavior.cancelPreparationAt && options.cancellable === true && /^正在准备/.test(title ?? '')
              && new RegExp(behavior.cancelPreparationAt).test(value.message) && !cancellation.requested) {
              emit('preparation-cancel-pressed', { message: value.message });
              handle.cancel();
            }
          }
        }, {
          get isCancellationRequested() { return cancellation.requested; },
          onCancellationRequested(listener) {
            cancellation.listeners.add(listener);
            return { dispose() { cancellation.listeners.delete(listener); } };
          }
        });
      } finally {
        if (activeCancellable === handle) activeCancellable = undefined;
      }
    },
    showInformationMessage: async (message, ...items) => {
      emit('notice', { message, items: items.filter((item) => typeof item === 'string') });
      if (behavior.closeWhenPostponed && message.startsWith('已改到下次启动时再合并较大的旧聊天记录')) void closeAfterPostponing();
      return undefined;
    },
    showWarningMessage: async (message, ...rest) => {
      const modal = typeof rest[0] === 'object' && rest[0]?.modal === true;
      emit('warning', { message, modal, ...(typeof rest[0] === 'object' && rest[0]?.detail ? { detail: rest[0].detail } : {}) });
      // The manual large merge's confirmation.
      return message === '中止旧数据中的工作后合并？' ? '同意收尾并合并' : modal && /^合并较大的旧聊天记录（/.test(message) ? '开始合并' : undefined;
    },
    showQuickPick: async (items, options) => {
      const resolved = await items;
      emit('quick-pick', { placeHolder: options?.placeHolder, labels: resolved.map((item) => item.label) });
      return behavior.manual === 'menu' && options?.placeHolder?.startsWith('历史与存储管理')
        ? resolved.find((item) => item.action === 'mergeAll') : undefined;
    },
    showErrorMessage: async (message, ...rest) => {
      emit('error-message', { message, ...(typeof rest[0] === 'object' && rest[0]?.detail ? { detail: rest[0].detail } : {}) });
      return undefined;
    }
  },
  commands: {
    executeCommand: async (id) => {
      if (id !== 'workbench.action.reloadWindow') return;
      emit('reload');
      // deactivate(), then the Extension Host process is replaced.
      await deactivate();
      process.exit(0);
    }
  }
};

// Opening like extension.ts: under the configuration admission, a long wait explained.
const openingWait = loadLayer('vscode/runtimeOpeningWait.ts', {}).createRuntimeOpeningWaitPresenter((status) => {
  if (status) emit('opening-status', { description: status.description });
});
const authority = new RootAuthority(() => resolveVscodeRuntimeDataRoot({ globalStoragePath: root }));
const runtime = await openUnderCurrentDataRootAdmission(async () => root, () => openFullRuntime({
  authority, settingsRoot, hostLabel: `${name}-${boot}`,
  async send() { throw new Error('no model call may happen after a merge'); }
}), 5, { onWait: (wait) => openingWait.onWait(wait), onAcquired: () => openingWait.settle() });
openingWait.end();
const database = runtime.app.database;
const paths = authority.expectedPaths();
emit('opened', { hostBootId: database.hostBootId });
let closing;
const closeRuntime = () => (closing ??= runtime.close());

// dataRootRelocation.afterDataRootOpened: what an interrupted operation of a dead process left is swept.
const swept = await sweepDataRootRelocationLeftovers(root).catch((error) => ({ removed: [], error: String(error?.message ?? error) }));
emit('swept', { removed: swept.removed.length, ...(swept.error ? { error: swept.error } : {}) });

// The Facade's own methods on this composition (the product's claim gate is not part of it).
const writeGate = new RuntimeWriteGate();
const facadeLike = { requireOpen() {}, writeGate, product: { application: { database }, freezeNewExecution: () => () => {} } };
const host = {
  product: { application: { database } },
  hasOwnedExecution: () => Facade.prototype.hasOwnedExecution.call(facadeLike),
  exclusiveMaintenanceTarget: () => ({ paths, hostBootId: database.hostBootId }),
  dataRootPath: () => root,
  withDataRootLocks: (body) => withRuntimeDataRootAdmission(root, () => withRuntimeMaintenance(paths, async () => {
    emit('locks-taken');
    try { return await body(); } finally { emit('locks-released'); }
  })),
  freezeNewWork: (activity) => {
    const thaw = Facade.prototype.freezeNewWork.call(facadeLike, activity);
    emit('frozen', { activity });
    return () => { thaw(); emit('thawed'); };
  },
  closeRuntime: async () => {
    emit('runtime-closing');
    await closeRuntime();
    emit('runtime-closed');
  },
  writeGate
};

const layer = loadLayer('vscode/runtimeExclusiveMaintenance.ts', { '../backend/reliableKernel/runtimeExclusiveMaintenance': exclusiveBackend });
const participant = layer.startExclusiveMaintenanceParticipant(host, {
  isCurrent: () => !deactivated, windowState, saveDrafts: () => 0, countdownSeconds: 0, pollMs: 50
});
await participant.checkNow();
const keptNotice = layer.takeNoticeKeptAcrossReload(windowState, activationStartedAt);
if (keptNotice) emit('kept-notice', { text: keptNotice });

/** extension.ts deactivate(): leaving first, then the Runtime (and its liveness record) closes, then the registration goes. */
async function deactivate() {
  deactivated = true;
  await participant.dispose().catch(() => undefined);
  await closeRuntime().catch(() => undefined);
  await participant.unregister().catch(() => undefined);
}

// The real engine adapter, watched: the session's order and sizes, and its progress (the kill and
// the user's cancel happen at a given point of it). Nothing it returns is changed.
const realEngine = engineModule.largeMergeEngine();
const mergingReports = new Map();
let lastStage;
let userCancelled = false;
const settledCodes = (report) => ({
  merged: report.merged.map((item) => item.candidateId),
  deferred: report.deferred.map((item) => item.code),
  blocked: report.blocked.map((item) => item.code),
  failures: report.failures.map((item) => item.code)
});
const watchedEngine = Object.freeze({
  ...realEngine,
  async estimate(input) {
    emit('estimating', { candidateIds: [...input.candidateIds], requested: input.requested });
    const estimated = await realEngine.estimate(input);
    emit('estimated', {
      sources: estimated.sources.map((source) => ({
        candidateId: source.candidateId, label: source.label, rows: source.rows, fingerprint: source.fingerprint, cached: source.cached,
        preparing: source.preparing, duration: source.duration
      })),
      preparing: estimated.preparing, duration: estimated.duration, space: estimated.space, stopped: estimated.stopped,
      settled: settledCodes(estimated.report)
    });
    return estimated;
  },
  async prepare(input) {
    emit('preparing', { candidateIds: [...input.candidateIds], requested: input.requested });
    const preparation = await realEngine.prepare(input);
    emit('prepared', {
      sources: preparation.sources.map((source) => ({
        candidateId: source.candidateId, label: source.label, rows: source.rows, fingerprint: source.fingerprint, duration: source.duration
      })),
      settled: settledCodes(preparation.report)
    });
    return preparation;
  },
  run: (input) => realEngine.run({
    ...input,
    onProgress(progress) {
      const stage = `${progress.index}:${progress.stage}`;
      if (stage !== lastStage) {
        lastStage = stage;
        emit('engine-stage', { index: progress.index, candidateId: progress.candidateId, stage: progress.stage, rowsDone: progress.rowsDone });
      }
      if (progress.stage === 'merging') {
        const count = (mergingReports.get(progress.index) ?? 0) + 1;
        mergingReports.set(progress.index, count);
        const at = (point) => point && point.index === progress.index && count >= point.merging;
        if (at(behavior.killAt)) {
          emit('killing', { index: progress.index, candidateId: progress.candidateId, rowsDone: progress.rowsDone });
          process.kill(process.pid, 'SIGKILL');
        }
        if (at(behavior.cancelAt) && !userCancelled && activeCancellable) {
          userCancelled = true;
          emit('cancel-pressed', { index: progress.index, candidateId: progress.candidateId, rowsDone: progress.rowsDone });
          activeCancellable.cancel();
        }
      }
      input.onProgress?.(progress);
    }
  })
});
const watchedEngineModule = { ...engineModule, largeMergeEngine: () => watchedEngine };
const lifetime = loadLayer('vscode/runtimeDataSetUpgradeLifetime.ts', {});
const largeMerge = loadLayer('vscode/commands/largeHistoricalMerge.ts', {
    './runtimeHistorySettlement': loadLayer('vscode/commands/runtimeHistorySettlement.ts', {}),
    '../../backend/application/reliableKernel/historicalMergeSettlement': require(path.join(compiled, 'backend/application/reliableKernel/historicalMergeSettlement.js')),
  '../../backend/reliableKernel/runtimeExclusiveMaintenance': exclusiveBackend,
  '../../backend/reliableKernel/runtimeLargeMergeEngine': watchedEngineModule,
  '../../backend/reliableKernel/runtimeLargeMergeSession': largeMergeSession,
  '../../shared/extensionIdentity': extensionIdentity,
  '../panels/MainPanel': { MainPanel: { saveComposerDrafts: () => 0 } },
  '../runtimeDataSetUpgradeLifetime': lifetime,
  '../runtimeExclusiveMaintenance': layer
});
// Only shorter: the prompt's countdown and the coordination's poll interval.
const shortened = { countdownSeconds: behavior.countdownSeconds ?? 1, coordination: { pollMs: 20 } };
const management = loadLayer('vscode/commands/runtimeDataSetManagement.ts', {
  './runtimeHistorySettlement': loadLayer('vscode/commands/runtimeHistorySettlement.ts', {}),
  './runtimeHistoryResiduals': { manageRuntimeHistoryResiduals: async () => undefined },
  '../../backend/application/reliableKernel/historicalMergeSettlement': require(path.join(compiled, 'backend/application/reliableKernel/historicalMergeSettlement.js')),
  '../../backend/reliableKernel/runtimeHistoryConvergence': kernelFile('runtimeHistoryConvergence.js'),
  '../../backend/reliableKernel/runtimeHistoryRegistry': kernelFile('runtimeHistoryRegistry.js'),
  '../../backend/reliableKernel/runtimeHistoryRepair': kernelFile('runtimeHistoryRepair.js'),
  '../../backend/reliableKernel/runtimeHistoryRepairInspection': kernelFile('runtimeHistoryRepairInspection.js'),
  '../../backend/capabilities/vscodeStorage/globalStatus': { loadCommittedGlobalStatus: async () => ({}), resolveDataRootUri: () => root },
  '../../backend/capabilities/vscodeStorage/paths': { createVscodeStoragePaths: () => ({ globalStoragePath: root }) },
  '../../backend/reliableKernel/vscodeRootAuthority': kernelFile('vscodeRootAuthority.js'),
  '../../backend/reliableKernel/runtimeDataSetHistory': kernelFile('runtimeDataSetHistory.js'),
  '../../backend/reliableKernel/runtimeDataSetUpgrade': kernelFile('runtimeDataSetUpgrade.js'),
  '../../backend/reliableKernel/runtimeDataSetMerge': kernelFile('runtimeDataSetMerge.js'),
  '../../backend/reliableKernel/runtimeDataSetPreflight': kernelFile('runtimeDataSetPreflight.js'),
  '../../backend/reliableKernel/runtimeExclusiveMaintenance': exclusiveBackend,
  '../../backend/reliableKernel/runtimeStorageInspection': kernelFile('runtimeStorageInspection.js'),
  '../../backend/reliableKernel/runtimeContentUsage': kernelFile('runtimeContentUsage.js'),
  '../../backend/reliableKernel/runtimeLargeMergeEngine': watchedEngineModule,
  '../../backend/reliableKernel/runtimeLargeMergeSession': largeMergeSession,
  '../runtimeDataSetUpgradeLifetime': lifetime,
  '../runtimeExclusiveMaintenance': layer,
  '../../shared/extensionIdentity': extensionIdentity,
  './foreignRuntimeHistory': { manageForeignRuntimeHistory: async () => undefined, announceForeignRuntimeHistoryOnStartup: async () => undefined },
  './largeHistoricalMerge': {
    ...largeMerge,
    offerLargeHistoricalMerge: (context, largeHost, ids, options) => largeMerge.offerLargeHistoricalMerge(context, largeHost, ids, { ...options, ...shortened }),
    startLargeHistoricalMerge: (context, largeHost, options) => largeMerge.startLargeHistoricalMerge(context, largeHost, { ...options, ...shortened })
  }
});
const context = { subscriptions: [], workspaceState: windowState, globalState };
const isCurrent = () => !deactivated;
emit('ready');

// extension.ts, once the Runtime is ready: the kept result, the upgrades then the background merge, the recovery.
void management.reportLargeHistoricalMergeKeptAcrossReload(context, isCurrent, activationStartedAt)
  .catch((error) => emit('failed', { step: 'kept-result', reason: String(error?.stack ?? error) }));
void management.upgradeHistoricalDataSetsOnStartup(context, isCurrent)
  .catch((error) => emit('failed', { step: 'upgrade', reason: String(error?.stack ?? error) }))
  .then(() => management.mergeHistoricalDataSetsInBackground(context, host, isCurrent))
  .then(async (report) => {
    if (!report) return;
    emit('batch', {
      merged: report.merged.map((item) => item.candidateId),
      deferred: report.deferred.map((item) => ({ candidateId: item.candidateId, code: item.code, message: item.message, rows: item.size?.rows })),
      blocked: report.blocked.map((item) => item.code),
      failures: report.failures.map((item) => item.code)
    });
    if (behavior.closeAfterBatch) { await closeAfterPostponing(); return; }
    if (behavior.manual === 'all') {
      await management.mergeAllRuntimeHistory(context, { current: () => host });
      emit('menu-done');
      return;
    }
    if (behavior.manual !== 'menu' && !behavior.lookAtMenu) return;
    // A moment later (not while the startup prompt still decides whether it is this window's), the user opens 历史与存储管理.
    await new Promise((resolve) => setTimeout(resolve, 500));
    await management.manageRuntimeDataSets(context, { current: () => host });
    emit('menu-done');
  }).catch((error) => emit('failed', { step: 'merge', reason: String(error?.stack ?? error) }));
const recovery = runtime.startupRecovery().then(
  (result) => ({ resumedTurnIds: result.runnerReport.resumedTurnIds, queuedConversationIds: result.runnerReport.queuedConversationIds }),
  (error) => ({ error: String(error?.message ?? error) })
);
if (behavior.settle) {
  const recovered = await recovery;
  await new Promise((resolve) => setTimeout(resolve, behavior.settleMs ?? 2_500));
  await runtime.runner.waitForIdle();
  emit('settled', { providerCalls: runtime.calls.length, ...recovered });
  if (behavior.reloadWhenSettled) await vscodeMock.commands.executeCommand('workbench.action.reloadWindow');
  if (behavior.closeWhenSettled) {
    await deactivate();
    emit('closed');
    process.exit(0);
  }
}

/** The user postponed the startup prompt: the window closes once its startup recovery settled (as a user closing it later). */
async function closeAfterPostponing() {
  await recovery;
  await runtime.runner.waitForIdle();
  await deactivate();
  emit('closed');
  process.exit(0);
}

/** Loads a real VS Code layer module with this window's vscode mock. */
function loadLayer(file, extra) {
  const ts = require('typescript');
  const filename = path.resolve(file);
  const module = { exports: {} };
  const dependencies = { vscode: vscodeMock, ...extra };
  vm.runInNewContext(ts.transpileModule(fsSync.readFileSync(filename, 'utf8'), {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS }
  }).outputText, {
    module, exports: module.exports, console, setInterval, clearInterval, setTimeout, clearTimeout, setImmediate, Promise, AbortController,
    require(dependency) {
      if (Object.prototype.hasOwnProperty.call(dependencies, dependency)) return dependencies[dependency];
      if (dependency.startsWith('node:')) return require(dependency);
      throw new Error(`Unexpected dependency ${dependency} of ${file}`);
    }
  }, { filename });
  return module.exports;
}
