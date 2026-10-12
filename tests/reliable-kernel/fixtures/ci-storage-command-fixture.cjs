const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');
const compiled = path.resolve(process.env.LIMCODE_TEST_EXTENSION_ROOT ?? 'dist/extension');
const primitive = require(path.join(compiled, 'backend/reliableKernel/runtimeExclusiveMaintenance.js'));
const hostControl = require(path.join(compiled, 'backend/reliableKernel/runtimeHostControl.js'));
const { createRuntimeRootPaths } = require(path.join(compiled, 'backend/reliableKernel/contracts.js'));
const WORK = fs.mkdtempSync(path.join(os.tmpdir(), 'limcode-ci-storage-command-'));
const SOURCE = path.join(WORK, 'source');
const TARGET = path.join(WORK, 'target');
fs.mkdirSync(SOURCE);
process.on('exit', () => fs.rmSync(WORK, { recursive: true, force: true }));
const plain = value => JSON.parse(JSON.stringify(value));

function loadCompiled(relative, dependencies) {
  const filename = path.join(compiled, relative.replace(/\.ts$/, '.js'));
  const module = { exports: {} };
  const builtins = { 'node:crypto': crypto, 'node:os': os, 'node:fs/promises': fs.promises, 'node:path': path };
  vm.runInNewContext(fs.readFileSync(filename, 'utf8'), {
    module, exports: module.exports, console, process, AbortController, setTimeout, clearTimeout,
    require(name) {
      if (Object.hasOwn(builtins, name)) return builtins[name];
      if (!Object.hasOwn(dependencies, name)) throw new Error(`Unexpected dependency: ${name}`);
      return dependencies[name];
    }
  }, { filename });
  return module.exports;
}

/** Real single-window coordination; only folder UI and the selected command's relocation I/O are synthetic. */
function fixture({ answers = [], busy = () => false, cancelStage = false, afterLocksError, lastMigration, carryBackError, movedNotice } = {}) {
  const calls = [], prompts = [];
  const cancellation = {
    listeners: [],
    onCancellationRequested(listener) {
      this.listeners.push(listener);
      return { dispose: () => { this.listeners = this.listeners.filter(value => value !== listener); } };
    }
  };
  const status = { dataRootPath: SOURCE, proxy: '', ...(lastMigration ? { lastMigration } : {}) };
  const paths = createRuntimeRootPaths(path.join(fs.mkdtempSync(path.join(SOURCE, 'window-')), 'runtime'));
  const database = { hostBootId: 'host-1' };
  const plan = {
    sourceRootPath: SOURCE, targetRootPath: TARGET, target: { kind: 'empty' },
    current: { id: 'default', dataSetId: 'current', rootInstanceId: 'instance', databaseBytes: 4096, casBytes: 1024, casAllocatedBytes: 4096, rows: 1 },
    others: [], configurationBytes: 100, configurationEntries: ['agents'], sameDevice: true, undoesEarlierAttempt: false,
    space: [{ label: '目标', path: TARGET, requiredBytes: 4096, freeBytes: 100000000 }], problems: [], warnings: []
  };
  const staged = { plan, relocationId: 'staged' };
  let frozen = 0;
  const vscode = {
    ProgressLocation: { Notification: 15 }, env: { appName: 'Code' },
    window: {
      async showOpenDialog() { return [{ fsPath: TARGET }]; },
      async showWarningMessage(message, ...rest) { calls.push(['warning', message, ...rest]); },
      async showInformationMessage(message, ...rest) { calls.push(['info', message, ...rest]); },
      async showErrorMessage(message, ...rest) { calls.push(['error', message, ...rest]); },
      async withProgress(_options, run) { return run({ report() {} }, cancellation); }
    },
    commands: { async executeCommand(command) { calls.push(['command', command]); } }
  };
  const host = {
    product: { application: { database } },
    async hasOwnedExecution() { return busy({ frozen: frozen > 0 }); },
    exclusiveMaintenanceTarget() { return { paths, hostBootId: database.hostBootId }; },
    dataRootPath() { return SOURCE; },
    async withDataRootLocks(run) {
      calls.push(['locks']);
      return hostControl.withRuntimeDataRootAdmission(SOURCE, () => hostControl.withRuntimeMaintenance(paths, run));
    },
    async closeRuntime() { calls.push(['close-runtime']); },
    freezeNewWork() { frozen++; calls.push(['freeze']); return () => { frozen--; calls.push(['thaw']); }; },
    postToWebview() { return true; }
  };
  const layer = loadCompiled('vscode/runtimeExclusiveMaintenance.ts', { vscode, '../backend/reliableKernel/runtimeExclusiveMaintenance': primitive });
  const dependencies = {
    vscode,
    '../../backend/capabilities/vscodeStorage/globalStatus': {
      LIMCODE_GLOBAL_STATUS_FILE: '.limcode-global-status.json',
      loadCommittedGlobalStatus: async () => status,
      resolveDataRootUri: (_context, root) => ({ fsPath: root || '/vscode/global-storage' }),
      sameFsPath: (a, b) => path.resolve(a) === path.resolve(b),
      GlobalStatusPendingRelocationConflictError: class extends Error {},
      async updateGlobalStatusDataRoot(_context, change) {
        calls.push(['status', plain(change)]);
        if (change.dataRootPath !== undefined) status.dataRootPath = change.dataRootPath;
        if (change.pendingRelocation === null) delete status.pendingRelocation;
        else if (change.pendingRelocation) status.pendingRelocation = change.pendingRelocation;
        if (change.lastMigration === null) delete status.lastMigration;
        else if (change.lastMigration) status.lastMigration = change.lastMigration;
        return status;
      }
    },
    '../../backend/reliableKernel/runtimeClaimPrimitives': { ownProcessStartIdentity: () => 'test-command-identity' },
    '../../backend/reliableKernel/runtimeDataRootRelocation': {
      DataRootRelocationError: class extends Error {}, formatBytes: bytes => `${bytes} B`,
      planDataRootRelocation: async () => plan,
      async stageDataRootRelocation(_plan, _source, options) {
        if (cancelStage) {
          cancellation.listeners.slice().forEach(listener => listener());
          assert.equal(options.signal.aborted, true);
          throw Object.assign(new Error('cancelled preparation'), { name: 'AbortError' });
        }
        return staged;
      },
      async completeDataRootRelocation(_staged, publish) {
        calls.push(['complete']);
        await publish({ dataRootId: '00000000-0000-4000-8000-000000000001' });
        return { targetRootPath: TARGET, merged: { insertedConversations: 1, insertedRows: 1, linkedCasObjects: 0, copiedCasObjects: 0, reusedCasObjects: 0 },
          configuration: { copiedFiles: 1, replacedFiles: 0 }, leftBehind: [] };
      },
      dataRootRelocationCleanupState: () => undefined,
      async abandonStagedDataRootRelocation() { calls.push(['abandon']); },
      DATA_ROOT_RELOCATION_MARKER_FILE: '.limcode-data-root-relocation.json', DATA_ROOT_MOVED_NOTICE_FILE: '.limcode-data-root-moved.json',
      inspectDataRootForReturn: async () => ({ usable: true }), assertDataRootAvailable: async () => {},
      ensureDataRootIdentity: async () => '00000000-0000-4000-8000-000000000002', invalidateDataRootRelocationRecord: async () => {},
      inspectDataRootMovedNotice: async () => movedNotice ? { notice: movedNotice } : { none: true },
      readDataRootMovedNotice: async () => movedNotice,
      consentToDataRootMovedWork: async () => true,
      async carryDeletionRecordsBack(input) { calls.push(['carry-back', input]); if (carryBackError) throw carryBackError; },
      findDataRootRelocationCopy: async () => undefined, readDataRootRelocationHold: async () => undefined,
      isDataRootRelocationTargetInvisible: () => false
    },
    '../../backend/reliableKernel/runtimeExclusiveMaintenance': primitive,
    '../../backend/reliableKernel/runtimeHostControl': { withRuntimeDataRootAdmission: async (_root, run) => run() },
    '../../backend/reliableKernel/vscodeRootAuthority': { assertConfigurationRootRuntimesOffline: async () => {} },
    '../../shared/extensionIdentity': { EXTENSION_BRAND: 'Limcode test', EXTENSION_COMMAND_IDS: { openPanel: 'limcode-test.openPanel' } },
    '../../backend/application/reliableKernel/relocatedWorkOpening': {},
    '../dataRootPrompts': { async askInSettingsPage(_host, _client, prompt) { prompts.push(prompt); return answers.shift() ?? { choice: 'cancel', include: [] }; } },
    '../runtimeExclusiveMaintenance': {
      ...layer,
      async runWithExclusiveMaintenance(maintenancePaths, options, operation) {
        calls.push(['exclusive']);
        const outcome = await layer.runWithExclusiveMaintenance(maintenancePaths, options, operation);
        if (afterLocksError && outcome.state === 'completed') throw afterLocksError;
        return outcome;
      }
    }
  };
  const commands = loadCompiled('vscode/commands/dataRootRelocation.ts', dependencies);
  const globalState = new Map(), workspaceState = new Map();
  const context = { globalStorageUri: { fsPath: '/vscode/global-storage' },
    globalState: { get: key => globalState.get(key), update: async (key, value) => { globalState.set(key, value); } },
    workspaceState: { get: key => workspaceState.get(key), update: async (key, value) => { workspaceState.set(key, value); } } };
  return { calls, prompts, commands, context, status, cancellation, request: { clientId: 'client-1' },
    startup: { wait: async () => host, pending: () => Promise.resolve(host) }, frozen: () => frozen,
    kinds: () => calls.map(call => call[0]) };
}

module.exports = { fixture, plain, SOURCE, TARGET };
