// One VS Code window of the new version as its own process, for runtime-exclusive-maintenance-windows.test.mjs.
// Like a real startup it opens a real RuntimeDatabase under the configuration admission (Facade.open),
// then starts the real participant layer (vscode/runtimeExclusiveMaintenance.ts with a vscode mock)
// and, unless told otherwise, runs the real background merge with the parameters of
// requestOtherWindowsToYield (vscode/commands/runtimeDataSetManagement.ts). A reload closes the
// Runtime and exits; the parent starts the next boot of the same window.
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
const { openUnderCurrentDataRootAdmission, withRuntimeDataRootAdmission, withRuntimeMaintenance } = kernelFile('runtimeHostControl.js');
const { VscodeReliableKernelApplicationFacade: Facade } = require(path.join(
  compiled, 'backend/application/reliableKernel/VscodeReliableKernelApplicationFacade.js'
));

const { root, name, boot, behavior } = JSON.parse(process.env.LIMCODE_EXCLUSIVE_MAINTENANCE_WINDOW);
const startedAt = Date.now();
const emit = (event, extra = {}) => new Promise((resolve) => {
  process.stdout.write(`${JSON.stringify({ name, boot, event, at: Date.now(), ...extra })}\n`, resolve);
});
setInterval(() => {}, 60_000);

const hostBootId = `${name}-boot-${boot}`;
const authority = new RootAuthority(() => resolveVscodeRuntimeDataRoot({ globalStoragePath: root }));
const database = await openUnderCurrentDataRootAdmission(async () => root,
  () => kernel.RuntimeDatabase.open(authority, { hostBootId }));
const paths = authority.expectedPaths();
await emit('opened', { hostBootId, startedAt });

const busyNow = () => behavior.busy === true && (!behavior.busyForMs || Date.now() - startedAt < behavior.busyForMs);
const facadeLike = { requireOpen() {}, product: { application: { database } } };
const host = {
  exclusiveMaintenanceTarget: () => ({ paths, hostBootId }),
  hasOwnedExecution: async () => busyNow() || Facade.prototype.hasOwnedExecution.call(facadeLike)
};
let participant;
const layer = loadVscodeLayer({
  ProgressLocation: { Notification: 15 },
  window: {
    state: { get focused() { return behavior.focused === true; } },
    withProgress: async (options, task) => {
      await emit('progress', { title: options.title, cancellable: options.cancellable === true });
      // The user presses "取消" on a cancellable countdown (behavior.cancelCountdown).
      return task({ report() {} }, {
        get isCancellationRequested() { return behavior.cancelCountdown === true && options.cancellable === true; },
        onCancellationRequested() {}
      });
    },
    showInformationMessage: async (message) => { await emit('notice', { message }); }
  },
  commands: {
    executeCommand: async (id) => {
      if (id !== 'workbench.action.reloadWindow') return;
      await emit('reload');
      // deactivate(): participant and Runtime close, then the Extension Host process is replaced.
      await participant?.dispose().catch(() => undefined);
      await database.close().catch(() => undefined);
      process.exit(0);
    }
  }
});
// An older version never takes part (behavior.participant === false).
if (behavior.participant !== false) {
  participant = layer.startExclusiveMaintenanceParticipant(host, { countdownSeconds: 0, pollMs: behavior.participantPollMs ?? 50 });
  await participant.checkNow();
}
await emit('ready');

if (behavior.request) {
  // This window asks the others to yield, outside the locks (a data-root migration the user confirmed).
  const outcome = await layer.runWithExclusiveMaintenance(paths, {
    operation: 'data-root-migration', operationKey: 'target:/new-root', message: '为迁移数据目录',
    waitingTitle: '正在等待其它窗口空闲后迁移数据目录', configurationRootPath: root, requesterHostBootId: hostBootId,
    requesterBusy: layer.requesterWorkBusy(host), ignoreBackoff: true, whenBusy: 'wait',
    participantConfirmation: 'final-countdown', pollMs: 20, isCurrent: () => true,
    withLocks: (body) => withRuntimeDataRootAdmission(root, () => withRuntimeMaintenance(paths, body))
  }, async () => { await emit('operation'); return 'migrated'; }).catch((error) => ({ state: 'threw', reason: String(error?.message ?? error) }));
  await emit('coordination', { state: outcome.state, reason: outcome.reason });
} else if (!behavior.noMerge) {
  const report = await mergeHistoricalDataSetsOnline({ globalStoragePath: root }, { configurationRootPath: root, database }, {
    limits: behavior.limits,
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
    blocked: report.blocked.map((item) => item.code),
    failures: report.failures.map((item) => item.code),
    pending: report.pendingSources
  });
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
    withLocks: input.withLocks,
    isCurrent: () => true
  }, merge).catch(async (error) => {
    await emit('coordination', { state: 'threw', requested: input.requested, reason: String(error?.message ?? error) });
    throw error;
  });
  await emit('coordination', { state: outcome.state, requested: input.requested, reason: outcome.reason });
  return outcome.state === 'completed' ? { state: 'completed' } : { state: outcome.state, reason: outcome.reason };
}

function loadVscodeLayer(vscodeModule) {
  const ts = require('typescript');
  const filename = path.resolve('vscode/runtimeExclusiveMaintenance.ts');
  const module = { exports: {} };
  const dependencies = { vscode: vscodeModule, '../backend/reliableKernel/runtimeExclusiveMaintenance': exclusive };
  vm.runInNewContext(ts.transpileModule(fsSync.readFileSync(filename, 'utf8'), {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS }
  }).outputText, {
    module, exports: module.exports, console, setInterval, clearInterval, setTimeout, clearTimeout,
    require(dependency) {
      if (!Object.prototype.hasOwnProperty.call(dependencies, dependency)) throw new Error(`Unexpected dependency ${dependency}`);
      return dependencies[dependency];
    }
  }, { filename });
  return module.exports;
}
