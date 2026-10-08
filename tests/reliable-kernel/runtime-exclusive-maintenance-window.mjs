// One VS Code window of the new version as its own process, for runtime-exclusive-maintenance-windows.test.mjs.
// Like a real startup it opens a real RuntimeDatabase under the configuration admission (Facade.open),
// then starts the real participant layer (vscode/runtimeExclusiveMaintenance.ts with a vscode mock)
// and, unless told otherwise, runs the real background merge with the parameters of
// requestOtherWindowsToYield (vscode/commands/runtimeDataSetManagement.ts). A reload closes the
// Runtime and exits; the parent starts the next boot of the same window. Behaviors:
//   busy / busyForMs      — this window's own work (hasOwnedExecution) from its start
//   focused               — the user is in this window; focusOnCountdownMs: the user clicks into it
//                           when its countdown appears and stays that long
//   countdownSeconds      — participant countdown length (0 by default)
//   workAfterConfirm      — { delayMs, forMs, once }: a Turn starts shortly after this window confirmed
//   request / requestOptions / operationMs — this window requests exclusive maintenance (a migration by default)
//   explicit              — the background merge is the call made for the user's click (candidateIds + requested)
//   failOperation         — the requested operation throws (with this code) after other windows yielded
//   reloadAfterFailure    — like dataRootRelocation.ts: the window reloads after the operation failed
//   windowStateFile       — this window's workspaceState (survives its reloads): windowState of the layer
//   closeAfterMs          — the user closes this window that long after it is ready (no next boot)
//   reloadAfterMs         — the user reloads this window that long after it is ready
//   closeGapMs            — closing its Runtime (the Host liveness record goes last) takes this long
//   request: 'large-session' — this window runs the large historical merge session of
//                           vscode/commands/largeHistoricalMerge.ts (the startup prompt, or with
//                           largeManual the manual entry) with a fake engine: largeSources
//                           [{ candidateId, rows, mergeMs }]; it closes its Runtime, merges, reloads
import { randomUUID } from 'node:crypto';
import fsSync from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const Module = require('node:module');
const originalLoad = Module._load;
Module._load = function load(name, parent, isMain) {
  return name === 'vscode'
    ? { EventEmitter: class { event = () => {}; }, Uri: { parse: (text) => ({ toString: () => text }) } }
    : originalLoad.call(this, name, parent, isMain);
};
const compiled = process.env.LIMCODE_TEST_EXTENSION_ROOT
  ? path.resolve(process.env.LIMCODE_TEST_EXTENSION_ROOT) : path.resolve('dist/extension');
const kernelFile = (file) => require(path.join(compiled, 'backend/reliableKernel', file));
const kernel = kernelFile('index.js');
const { RootAuthority } = kernelFile('rootAuthority.js');
const { resolveVscodeRuntimeDataRoot } = kernelFile('vscodeRootAuthority.js');
const { mergeHistoricalDataSetsOnline } = kernelFile('runtimeDataSetMerge.js');
const exclusive = kernelFile('runtimeExclusiveMaintenance.js');
const {
  assertRuntimeHostsOffline, isRuntimeDataRootAdmissionHeld, isRuntimeMaintenanceHeld, openUnderCurrentDataRootAdmission,
  withRuntimeDataRootAdmission, withRuntimeMaintenance
} = kernelFile('runtimeHostControl.js');
const largeMergeSession = kernelFile('runtimeLargeMergeSession.js');
const { VscodeReliableKernelApplicationFacade: Facade } = require(path.join(
  compiled, 'backend/application/reliableKernel/VscodeReliableKernelApplicationFacade.js'
));
const { RuntimeWriteGate } = require(path.join(compiled, 'backend/application/reliableKernel/runtimeWriteGate.js'));

const { root, name, boot, behavior } = JSON.parse(process.env.LIMCODE_EXCLUSIVE_MAINTENANCE_WINDOW);
const startedAt = Date.now();
const emit = (event, extra = {}) => new Promise((resolve) => {
  process.stdout.write(`${JSON.stringify({ name, boot, event, at: Date.now(), ...extra })}\n`, resolve);
});
setInterval(() => {}, 60_000);

// This window's workspaceState: a file that outlives the process.
const readWindowState = () => (fsSync.existsSync(behavior.windowStateFile) ? JSON.parse(fsSync.readFileSync(behavior.windowStateFile, 'utf8')) : {});
const windowState = behavior.windowStateFile ? {
  get: (key) => readWindowState()[key],
  update: async (key, value) => {
    const all = readWindowState();
    if (value === undefined) delete all[key];
    else all[key] = value;
    fsSync.writeFileSync(behavior.windowStateFile, JSON.stringify(all));
  }
} : undefined;

let focused = behavior.focused === true;
let workUntil = behavior.busy === true ? (behavior.busyForMs ? startedAt + behavior.busyForMs : Infinity) : 0;
let workScheduled = false;
const vscodeMock = {
  ProgressLocation: { Notification: 15, Window: 10 },
  env: { sessionId: behavior.sessionId ?? `session-${name}-${boot}` },
  window: {
    state: { get focused() { return focused; } },
    withProgress: async (options, task) => {
      const countdown = /即将重载/.test(options.title ?? '');
      await emit('progress', { title: options.title, cancellable: options.cancellable === true, countdown });
      // The large merge session's own notifications have no title: every message is recorded.
      if (options.title === undefined) {
        return task({ report: (value) => { if (value?.message) void emit('progress-report', { message: value.message }); } }, {
          isCancellationRequested: false, onCancellationRequested() { return { dispose() {} }; }
        });
      }
      if (countdown && behavior.focusOnCountdownMs) {
        // The user clicks into the window whose countdown just appeared, then goes back.
        focused = true;
        setTimeout(() => { focused = false; }, behavior.focusOnCountdownMs);
      }
      // The user presses "取消" on a cancellable countdown (behavior.cancelCountdown).
      const result = await task({ report() {} }, {
        get isCancellationRequested() { return behavior.cancelCountdown === true && options.cancellable === true; },
        onCancellationRequested() {}
      });
      if (countdown && behavior.workAfterConfirm && !(behavior.workAfterConfirm.once && workScheduled)) {
        workScheduled = true;
        const { delayMs, forMs } = behavior.workAfterConfirm;
        setTimeout(() => { workUntil = Date.now() + forMs; void emit('work-start'); }, delayMs);
      }
      return result;
    },
    showInformationMessage: async (message) => { await emit('notice', { message }); },
    showWarningMessage: async (message) => {
      await emit('warning', { message });
      // The manual large merge's confirmation.
      return /^合并较大的旧聊天记录（/.test(message) ? '开始合并' : undefined;
    },
    showErrorMessage: async (message) => { await emit('error-message', { message }); }
  },
  commands: {
    executeCommand: async (id) => {
      if (id !== 'workbench.action.reloadWindow') return;
      await emit('reload');
      // deactivate(), then the Extension Host process is replaced.
      await deactivate();
      process.exit(0);
    }
  }
};
let participant;
let database;

/** extension.ts deactivate(): leaving first, then the Runtime (and its liveness record) closes, then the registration goes. */
async function deactivate() {
  await participant?.dispose().catch(() => undefined);
  if (behavior.closeGapMs) await new Promise((resolve) => setTimeout(resolve, behavior.closeGapMs));
  await database?.close().catch(() => undefined);
  await participant?.unregister().catch(() => undefined);
}

// Opening like extension.ts: a long wait on the admission is explained (runtimeOpeningWait.ts).
const openingWait = loadLayer('vscode/runtimeOpeningWait.ts', {}).createRuntimeOpeningWaitPresenter((status) => {
  if (status) void emit('opening-status', { description: status.description });
});
const hostBootId = `${name}-boot-${boot}`;
const authority = new RootAuthority(() => resolveVscodeRuntimeDataRoot({ globalStoragePath: root }));
const openStarted = Date.now();
database = await openUnderCurrentDataRootAdmission(async () => root,
  () => kernel.RuntimeDatabase.open(authority, { hostBootId }), 5,
  { onWait: (wait) => openingWait.onWait(wait), onAcquired: () => openingWait.settle() });
openingWait.end();
const paths = authority.expectedPaths();
await emit('opened', { hostBootId, startedAt, openMs: Date.now() - openStarted });

const busyNow = () => Date.now() < workUntil;
const facadeLike = { requireOpen() {}, product: { application: { database } }, writeGate: new RuntimeWriteGate() };
const host = {
  exclusiveMaintenanceTarget: () => ({ paths, hostBootId }),
  hasOwnedExecution: async () => busyNow() || Facade.prototype.hasOwnedExecution.call(facadeLike)
};
const layer = loadLayer('vscode/runtimeExclusiveMaintenance.ts', { '../backend/reliableKernel/runtimeExclusiveMaintenance': exclusive });
// An older version never takes part (behavior.participant === false).
if (behavior.participant !== false) {
  participant = layer.startExclusiveMaintenanceParticipant(host, {
    countdownSeconds: behavior.countdownSeconds ?? 0, pollMs: behavior.participantPollMs ?? 50,
    ...(windowState ? { windowState } : {})
  });
  await participant.checkNow();
}
// Shown once after a reload (extension.ts).
const kept = windowState ? layer.takeNoticeKeptAcrossReload(windowState, startedAt) : undefined;
if (kept) await emit('kept-notice', { text: kept });
// The large merge session's outcome, kept by this window before it reloaded (runtimeDataSetManagement).
const keptLarge = windowState ? largeMergeSession.takeLargeMergeResult(windowState, startedAt) : undefined;
if (keptLarge) {
  await emit('kept-large-result', {
    merged: keptLarge.report?.merged.map((item) => [item.candidateId, item.insertedConversations]) ?? [],
    deferred: keptLarge.report?.deferred.map((item) => item.code) ?? [], details: keptLarge.details, error: keptLarge.error
  });
}
await emit('ready');
if (behavior.closeAfterMs) {
  setTimeout(async () => {
    await emit('closing');
    await deactivate();
    await emit('closed');
    process.exit(0);
  }, behavior.closeAfterMs);
}
if (behavior.reloadAfterMs) {
  setTimeout(() => { void vscodeMock.commands.executeCommand('workbench.action.reloadWindow'); }, behavior.reloadAfterMs);
}
if (behavior.requestAfterMs) await new Promise((resolve) => setTimeout(resolve, behavior.requestAfterMs));

const withTrackedLocks = (take) => async (body) => {
  await emit('locks-wanted');
  return take(async () => {
    const lockedAt = Date.now();
    await emit('locks-taken');
    try { return await body(); } finally { await emit('locks-released', { heldMs: Date.now() - lockedAt }); }
  });
};

if (behavior.request === 'large-session') {
  await runLargeSession();
} else if (behavior.request) {
  // This window asks the others to yield, outside the locks (a data-root migration the user confirmed;
  // like dataRootRelocation.ts, the key carries the attempt's own id).
  const outcome = await layer.runWithExclusiveMaintenance(paths, {
    operation: 'data-root-migration', operationKey: `target:/new-root#${randomUUID()}`, message: '为迁移数据目录',
    waitingTitle: '正在等待其它窗口空闲后迁移数据目录', configurationRootPath: root, requesterHostBootId: hostBootId,
    requesterBusy: layer.requesterWorkBusy(host), ignoreBackoff: true, whenBusy: 'wait',
    participantConfirmation: 'final-countdown', pollMs: 20, isCurrent: () => true,
    ...(behavior.requestOptions ?? {}),
    withLocks: withTrackedLocks((body) => withRuntimeDataRootAdmission(root, () => withRuntimeMaintenance(paths, body)))
  }, async () => {
    await emit('operation');
    if (behavior.operationMs) await new Promise((resolve) => setTimeout(resolve, behavior.operationMs));
    if (behavior.failOperation) throw Object.assign(new Error('目标目录写入失败'), { code: behavior.failOperation });
    return 'migrated';
  }).catch((error) => ({ state: 'threw', reason: String(error?.message ?? error) }));
  await emit('coordination', { state: outcome.state, reason: outcome.reason, retryAfter: outcome.retryAfter });
  if (outcome.state === 'threw' && behavior.reloadAfterFailure) await vscodeMock.commands.executeCommand('workbench.action.reloadWindow');
} else if (!behavior.noMerge) {
  const report = await mergeHistoricalDataSetsOnline({ globalStoragePath: root }, { configurationRootPath: root, database }, {
    limits: behavior.limits,
    ...(behavior.explicit ? { candidateIds: [behavior.explicit], requested: true } : {}),
    ...(behavior.failLink ? {
      // Stands in for a persistent I/O failure while linking/copying CAS (EIO, EACCES, ENOSPC …).
      linkFile: async () => { throw Object.assign(new Error('input/output error'), { code: 'EIO' }); }
    } : {}),
    ...(behavior.failCommit ? {
      // Stands in for a persistent failure of the final commit, the only step after the other
      // windows yielded (the CAS transfer and the backup run before any coordination).
      onFaultPoint(point) {
        if (point === 'before-row-commit') throw Object.assign(new Error('input/output error'), { code: 'EIO' });
      }
    } : {}),
    coordinateOversized: (input, merge) => requestOtherWindowsToYield({ globalStoragePath: root }, input, merge)
  });
  await emit('report', {
    merged: report.merged.map((item) => item.candidateId),
    deferred: report.deferred.map((item) => item.code),
    deferredMessages: report.deferred.map((item) => item.message),
    blocked: report.blocked.map((item) => item.code),
    failures: report.failures.map((item) => item.code),
    pending: report.pendingSources
  });
}

/**
 * The large merge session of this window with the real session layer and coordination, and a fake
 * engine whose merge checks it runs in the exclusive phase (both claims held, every Host offline).
 */
async function runLargeSession() {
  const sources = (behavior.largeSources ?? []).map((source, index) => ({
    candidateId: source.candidateId, runtimeDataRootPath: `/fixture/${source.candidateId}`, fingerprint: `fingerprint-${index}`,
    rows: source.rows, databaseBytes: 1024 * 1024,
    duration: { expectedMs: source.mergeMs, minMs: Math.round(source.mergeMs * 0.8), maxMs: Math.round(source.mergeMs * 1.6) }
  }));
  // The engine's own figures: the sources, the largest one's WAL peak, 64 MiB; one private copy in the temporary directory;
  // SQLite's temporary files (a quarter of the largest source) in its temporary directory.
  const space = {
    targetDirectory: paths.dataRootPath, targetBytes: 70 * 1024 * 1024, temporaryDirectory: root, temporaryBytes: 1024 * 1024,
    sqliteTemporaryDirectory: root, sqliteTemporaryBytes: 256 * 1024
  };
  const engine = {
    waiting: async () => sources.map(({ candidateId, rows }) => ({ candidateId, rows, bytes: rows * 100 })),
    noteBatch: () => {},
    // Read-only, before the prompt or the confirmation: both durations (preparing here as long as the merge).
    estimate: async ({ candidateIds }) => {
      await emit('engine-estimate', { candidateIds });
      const estimated = sources.filter((source) => candidateIds.includes(source.candidateId))
        .map((source) => ({ ...source, preparing: source.duration, cached: true }));
      const sum = (durations) => durations.reduce((total, item) => ({
        expectedMs: total.expectedMs + item.expectedMs, minMs: total.minMs + item.minMs, maxMs: total.maxMs + item.maxMs
      }), { expectedMs: 0, minMs: 0, maxMs: 0 });
      return {
        sources: estimated, report: { merged: [], deferred: [], blocked: [], failures: [] }, space,
        preparing: sum(estimated.map((source) => source.preparing)), duration: sum(estimated.map((source) => source.duration)), stopped: false
      };
    },
    prepare: async ({ candidateIds }) => {
      await emit('engine-prepare', { candidateIds });
      return {
        sources: sources.filter((source) => candidateIds.includes(source.candidateId)),
        report: { merged: [], deferred: [], blocked: [], failures: [] },
        space,
        engineState: 'fake'
      };
    },
    release: async () => undefined,
    run: async ({ preparation, signal, onProgress }) => {
      let offline = 'offline';
      try { await assertRuntimeHostsOffline(paths); } catch (error) { offline = String(error?.message ?? error); }
      await emit('engine-run', { offline, admission: isRuntimeDataRootAdmissionHeld(root), maintenance: isRuntimeMaintenanceHeld(paths) });
      const rowsTotal = preparation.sources.reduce((sum, source) => sum + source.rows, 0);
      let rowsWritten = 0;
      const outcomes = [];
      for (const [index, source] of preparation.sources.entries()) {
        const steps = Math.max(1, Math.round(source.duration.expectedMs / 20));
        for (let step = 1; step <= steps; step += 1) {
          if (signal.aborted) break;
          await new Promise((resolve) => setTimeout(resolve, 20));
          onProgress({
            index, total: preparation.sources.length, candidateId: source.candidateId, stage: 'merging',
            rowsDone: rowsWritten + Math.round((source.rows * step) / steps), rowsTotal
          });
        }
        rowsWritten += source.rows;
        outcomes.push({ candidateId: source.candidateId, state: 'merged', result: {
          candidateId: source.candidateId, sourceDataSetId: `source-${index}`, targetDataSetId: 'target', insertedRows: source.rows, reusedRows: 0,
          insertedConversations: 10 + index, linkedCasObjects: 0, copiedCasObjects: 0, reusedCasObjects: 0, recoveredCommit: false
        } });
      }
      return outcomes;
    }
  };
  const lifetime = loadLayer('vscode/runtimeDataSetUpgradeLifetime.ts', {});
  const session = loadLayer('vscode/commands/largeHistoricalMerge.ts', {
    './runtimeHistorySettlement': loadLayer('vscode/commands/runtimeHistorySettlement.ts', {}),
    '../../backend/application/reliableKernel/historicalMergeSettlement': require(path.join(compiled, 'backend/application/reliableKernel/historicalMergeSettlement.js')),
    '../../backend/reliableKernel/runtimeExclusiveMaintenance': exclusive,
    '../../backend/reliableKernel/runtimeLargeMergeEngine': kernelFile('runtimeLargeMergeEngine.js'),
    '../../backend/reliableKernel/runtimeLargeMergeSession': largeMergeSession,
    '../../shared/extensionIdentity': require(path.join(compiled, 'shared/extensionIdentity.js')),
    '../panels/MainPanel': { MainPanel: { saveComposerDrafts: () => 0 } },
    '../runtimeDataSetUpgradeLifetime': lifetime,
    '../runtimeExclusiveMaintenance': layer
  });
  const writeGate = facadeLike.writeGate;
  const largeHost = {
    product: { application: { database } },
    hasOwnedExecution: host.hasOwnedExecution,
    exclusiveMaintenanceTarget: host.exclusiveMaintenanceTarget,
    dataRootPath: () => root,
    withDataRootLocks: withTrackedLocks((body) => withRuntimeDataRootAdmission(root, () => withRuntimeMaintenance(paths, body))),
    freezeNewWork: (activity) => {
      const thaw = writeGate.freeze(activity, []);
      void emit('frozen', { activity });
      return () => { thaw(); void emit('thawed'); };
    },
    closeRuntime: async () => {
      await emit('runtime-closing');
      await database.close();
      await emit('runtime-closed');
    },
    writeGate
  };
  const options = {
    report: async (batch, requested) => { await emit('large-report', { requested, deferred: batch.deferred.map((item) => item.code) }); },
    isCurrent: () => true,
    engine,
    ...(windowState ? { windowState } : {}),
    saveDrafts: () => 0,
    probeDisk: async () => ({ device: 1, freeBytes: 1e12 }),
    countdownSeconds: behavior.largeCountdownSeconds ?? 1,
    coordination: { pollMs: 20 }
  };
  const context = { workspaceState: windowState };
  const ids = sources.map((source) => source.candidateId);
  if (behavior.largeManual) await session.startLargeHistoricalMerge(context, largeHost, { ...options, candidateIds: ids });
  else await session.offerLargeHistoricalMerge(context, largeHost, ids, options);
  await emit('large-session-ended');
}

/** The parameters of requestOtherWindowsToYield in vscode/commands/runtimeDataSetManagement.ts. */
async function requestOtherWindowsToYield(storagePaths, input, merge) {
  const outcome = await layer.runWithExclusiveMaintenance(input.targetPaths, {
    operation: 'historical-merge',
    operationKey: input.operationKey,
    message: '为合并较大的旧聊天记录',
    waitingTitle: '正在等待其它窗口空闲后合并较大的旧聊天记录',
    configurationRootPath: storagePaths.globalStoragePath,
    requesterHostBootId: input.requesterHostBootId,
    ignoreBackoff: input.requested,
    ...(input.requested ? { whenBusy: 'wait', participantConfirmation: 'notice' } : {}),
    isDeterministicFailure: input.isDeterministicFailure,
    withLocks: withTrackedLocks(input.withLocks),
    isCurrent: () => true
  }, merge).catch(async (error) => {
    await emit('coordination', { state: 'threw', requested: input.requested, reason: String(error?.message ?? error) });
    throw error;
  });
  await emit('coordination', { state: outcome.state, requested: input.requested, reason: outcome.reason, retryAfter: outcome.retryAfter });
  return outcome.state === 'completed' ? { state: 'completed' } : { state: outcome.state, reason: outcome.reason };
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
    module, exports: module.exports, console, setInterval, clearInterval, setTimeout, clearTimeout, Promise, AbortController,
    require(dependency) {
      if (!Object.prototype.hasOwnProperty.call(dependencies, dependency)) throw new Error(`Unexpected dependency ${dependency}`);
      return dependencies[dependency];
    }
  }, { filename });
  return module.exports;
}
