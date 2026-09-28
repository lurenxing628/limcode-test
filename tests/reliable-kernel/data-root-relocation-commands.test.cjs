const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const os = require('node:os');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const test = require('node:test');
const ts = require('typescript');

// The coordination is real: vscode/runtimeExclusiveMaintenance.ts over the compiled primitive, with
// real locks in a temporary directory. The migration backend and the UI are recording fakes.
const compiled = path.resolve(process.env.LIMCODE_TEST_EXTENSION_ROOT ?? 'dist/extension');
const primitive = require(path.join(compiled, 'backend/reliableKernel/runtimeExclusiveMaintenance.js'));
const hostControl = require(path.join(compiled, 'backend/reliableKernel/runtimeHostControl.js'));
const { createRuntimeRootPaths } = require(path.join(compiled, 'backend/reliableKernel/contracts.js'));
const { ownProcessStartIdentity } = require(path.join(compiled, 'backend/reliableKernel/runtimeClaimPrimitives.js'));

/** Transpiles a source file and runs it with exactly the given dependencies. */
function loadSource(relative, dependencies) {
  const filename = path.resolve(__dirname, '../..', relative);
  const module = { exports: {} };
  vm.runInNewContext(ts.transpileModule(fs.readFileSync(filename, 'utf8'), {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS }
  }).outputText, {
    module, exports: module.exports, console, process, AbortController, setTimeout, clearTimeout,
    require(name) {
      if (name === 'node:crypto') return crypto;
      if (name === 'node:os') return os;
      if (name === 'node:fs/promises') return fs.promises;
      if (name === 'node:path') return path;
      if (!Object.prototype.hasOwnProperty.call(dependencies, name)) throw new Error(`Unexpected source dependency: ${name}`);
      return dependencies[name];
    }
  }, { filename });
  return module.exports;
}

/** Loads vscode/commands/dataRootRelocation.ts with the given dependencies (fakes except the coordination). */
function loadCommands(dependencies) {
  return loadSource('vscode/commands/dataRootRelocation.ts', dependencies);
}

const WORK = fs.mkdtempSync(path.join(os.tmpdir(), 'limcode-relocation-commands-'));
process.on('exit', () => fs.rmSync(WORK, { recursive: true, force: true }));
const SOURCE = path.join(WORK, 'old-home');
const TARGET = path.join(WORK, 'new-home');
fs.mkdirSync(SOURCE, { recursive: true });
const plain = (value) => JSON.parse(JSON.stringify(value));

function fixture({
  picked = TARGET, plan = {}, answers = [], busy = [false], completeError, cleanup,
  closeError, abandonError, lastMigration, pendingRelocation, ownerState = 'dead', returnUsable = true, currentAvailable = true,
  host = true, deletion = {}, deleteResult = { removed: ['data-set:default'], remainingDataSets: 0 }, recoveryChoice,
  nativeAnswers = [], recoverOutcome = 'recovered', cancelStage = false, movedNotice, copyAside, hold,
  afterLocksError, statusUnreadable = false, undoUnpublishedResult = {},
  /** What inspectDataRootMovedNotice finds (an Error: the read fails); by default `movedNotice` or none. */
  movedRead, consentError
} = {}) {
  const calls = [];
  const abandonOptions = [];
  const progressOptions = [];
  const cancellation = { listeners: [], onCancellationRequested(listener) { this.listeners.push(listener); return { dispose: () => { this.listeners = this.listeners.filter((entry) => entry !== listener); } }; } };
  const prompts = [];
  const status = {
    dataRootPath: SOURCE, proxy: 'http://proxy', proxyShellAndMcp: true,
    ...(lastMigration ? { lastMigration } : {}), ...(pendingRelocation ? { pendingRelocation } : {})
  };
  const planFor = (targetRootPath) => ({
    sourceRootPath: SOURCE, targetRootPath, target: { kind: 'empty' },
    current: { id: 'default', dataSetId: 'current', rootInstanceId: 'instance', databaseBytes: 4096, casBytes: 1024, casAllocatedBytes: 4096, rows: 120 },
    others: [], configurationBytes: 100, configurationEntries: ['agents', 'AGENTS.md'], sameDevice: true, undoesEarlierAttempt: false,
    space: [{ label: '新数据目录', path: '/data', requiredBytes: 70_000_000, freeBytes: 900_000_000 }],
    problems: [], warnings: [], ...(typeof plan === 'function' ? plan(targetRootPath) : plan)
  });
  const vscode = {
    window: {
      async showOpenDialog(options) { calls.push(['open-dialog', options]); return picked ? [{ fsPath: picked }] : undefined; },
      async showWarningMessage(message, options, ...items) { calls.push(['warning', message, options, items]); return nativeAnswers.shift(); },
      async showInformationMessage(message, options) { calls.push(['info', message, options]); },
      async showErrorMessage(message, ...rest) { calls.push(['error', message, ...rest]); return recoveryChoice; },
      async withProgress(options, action) {
        progressOptions.push(options);
        return action({ report: (value) => calls.push(['progress', value.message]) }, cancellation);
      }
    },
    ProgressLocation: { Notification: 15 },
    env: { appName: 'Code' },
    commands: { async executeCommand(command, argument) { calls.push(['command', command, argument]); } }
  };
  const staged = { plan: planFor(TARGET), relocationId: 'staged' };
  const database = { hostBootId: 'host-1' };
  // This window's selected root: its own directory, so coordination records never leak between fixtures.
  const paths = createRuntimeRootPaths(path.join(fs.mkdtempSync(path.join(SOURCE, 'window-')), 'runtime'));
  let frozen = 0;
  const application = host ? {
    product: { application: { database } },
    /** `busy`: a list consumed per check (the last value stays), or a function of this window's state. */
    async hasOwnedExecution() {
      const value = typeof busy === 'function'
        ? busy({ frozen: frozen > 0, locked: hostControl.isRuntimeMaintenanceHeld(paths) })
        : busy.length > 1 ? busy.shift() : busy[0];
      calls.push(['busy?', value instanceof Error ? 'error' : value]);
      if (value instanceof Error) throw value;
      return value;
    },
    exclusiveMaintenanceTarget() { return { paths, hostBootId: 'host-1' }; },
    dataRootPath() { return SOURCE; },
    async withDataRootLocks(body) {
      calls.push(['locks']);
      return hostControl.withRuntimeDataRootAdmission(SOURCE, () => hostControl.withRuntimeMaintenance(paths, body));
    },
    async closeRuntime() { calls.push(['close-runtime']); if (closeError) throw closeError; },
    freezeNewWork(activity) {
      frozen += 1;
      calls.push(['freeze', activity]);
      return () => { frozen -= 1; calls.push(['thaw']); };
    },
    postToWebview() { return true; }
  } : undefined;
  const startup = {
    wait: async () => { if (!application) throw new Error('no runtime'); return application; },
    pending: () => (application ? Promise.resolve(application) : undefined)
  };
  const cleanupStates = new WeakMap();
  const dependencies = {
    vscode,
    '../../backend/capabilities/vscodeStorage/globalStatus': {
      LIMCODE_GLOBAL_STATUS_FILE: '.limcode-global-status.json',
      loadCommittedGlobalStatus: async () => {
        // Readable until the relocation ran into trouble (statusUnreadable: from its failure on).
        if (statusUnreadable && calls.some((call) => call[0] === 'complete')) throw new Error('EIO: i/o error, read');
        return status;
      },
      resolveDataRootUri: (_context, dataRootPath) => ({ fsPath: dataRootPath || '/vscode/global-storage' }),
      sameFsPath: (left, right) => path.resolve(left) === path.resolve(right),
      GlobalStatusPendingRelocationConflictError: class GlobalStatusPendingRelocationConflictError extends Error {},
      updateGlobalStatusDataRoot: async (_context, change) => {
        calls.push(['status', plain(change)]);
        if (change.expectedPendingRelocationId !== undefined && (status.pendingRelocation?.relocationId ?? null) !== change.expectedPendingRelocationId) {
          if (change.pendingRelocation) throw new dependencies['../../backend/capabilities/vscodeStorage/globalStatus'].GlobalStatusPendingRelocationConflictError('另一个 LimCode 窗口刚刚开始了数据目录迁移');
          change = { ...change, pendingRelocation: undefined };
        }
        if (change.dataRootPath !== undefined) status.dataRootPath = change.dataRootPath;
        if (change.pendingRelocation === null) delete status.pendingRelocation;
        else if (change.pendingRelocation) status.pendingRelocation = change.pendingRelocation;
        if (change.lastMigration === null) delete status.lastMigration;
        else if (change.lastMigration) status.lastMigration = change.lastMigration;
        return status;
      }
    },
    '../../backend/reliableKernel/runtimeClaimPrimitives': { ownProcessStartIdentity: () => 'start-identity' },
    '../../backend/reliableKernel/runtimeDataRootRelocation': {
      DataRootRelocationError: class DataRootRelocationError extends Error {
        constructor(code, message) { super(message); this.code = code; }
      },
      formatBytes: (bytes) => `${bytes} B`,
      planDataRootRelocation: async ({ targetRootPath, sourceDatabase }) => {
        calls.push(['plan', targetRootPath, sourceDatabase === database]);
        return planFor(targetRootPath);
      },
      stageDataRootRelocation: async (planned, sourceDatabase, options) => {
        calls.push(['stage', planned.targetRootPath, sourceDatabase === database, options.relocationId]);
        assert.equal(options.signal?.aborted, false, '准备阶段带着可取消的信号');
        if (cancelStage) {
          // The user presses "Cancel" on the progress notification while the pre-copy runs.
          for (const listener of [...cancellation.listeners]) listener();
          assert.equal(options.signal.aborted, true);
          throw Object.assign(new Error('The operation was aborted'), { name: 'AbortError' });
        }
        return staged;
      },
      completeDataRootRelocation: async (input, publish) => {
        assert.equal(input, staged);
        calls.push(['complete']);
        if (completeError) {
          if (cleanup) cleanupStates.set(completeError, cleanup);
          throw completeError;
        }
        await publish({ dataRootId: '00000000-0000-4000-8000-000000000001' });
        return {
          targetRootPath: TARGET,
          merged: { insertedConversations: 3, insertedRows: 40, linkedCasObjects: 2, copiedCasObjects: 0, reusedCasObjects: 1 },
          configuration: { copiedFiles: 5, replacedFiles: 0 },
          others: { migrated: ['workspace:a'], covered: [], leftBehind: [{ id: 'workspace:b', reason: '数据较多' }] }
        };
      },
      dataRootRelocationCleanupState: (error) => (error && typeof error === 'object' ? cleanupStates.get(error) : undefined),
      abandonStagedDataRootRelocation: async (input, options) => {
        calls.push(['abandon', input === staged]);
        abandonOptions.push(plain(options ?? {}));
        if (abandonError) throw abandonError;
      },
      DATA_ROOT_RELOCATION_MARKER_FILE: '.limcode-data-root-relocation.json',
      dataRootRelocationOwnerState: () => ownerState,
      inspectDataRootForReturn: async (root) => { calls.push(['inspect-return', root]); return returnUsable ? { usable: true } : { usable: false, message: '没有当前库' }; },
      assertDataRootAvailable: async () => { if (!currentAvailable) throw new Error('unavailable'); },
      ensureDataRootIdentity: async (root) => { calls.push(['identity', root]); return '00000000-0000-4000-8000-000000000002'; },
      invalidateDataRootRelocationRecord: async (root) => { calls.push(['invalidate', root]); },
      planOldDataRootDeletion: async (input) => {
        calls.push(['plan-delete', plain(input)]);
        return { oldRootPath: input.oldRootPath, problems: [], items: [], kept: [], ...deletion };
      },
      deleteOldDataRoot: async (input) => { calls.push(['delete', plain(input)]); return deleteResult; },
      recoverInterruptedDataRootRelocation: async (input) => { calls.push(['recover', plain(input)]); return recoverOutcome; },
      finalizeDataRootRelocation: async (root) => { calls.push(['finalize', root]); },
      readDataRootMovedNotice: async (root) => {
        calls.push(['read-moved', root]);
        if (movedRead instanceof Error) throw movedRead;
        return movedRead && !movedRead.notice ? undefined : movedNotice;
      },
      inspectDataRootMovedNotice: async (root) => {
        calls.push(['inspect-moved', root]);
        if (movedRead instanceof Error) throw movedRead;
        return movedRead ?? (movedNotice ? { notice: movedNotice } : { none: true });
      },
      DATA_ROOT_MOVED_NOTICE_FILE: '.limcode-data-root-moved.json',
      clearDataRootMovedNotice: async (root, installation) => { calls.push(['clear-moved', root, installation]); return false; },
      sweepDataRootRelocationLeftovers: async (root) => { calls.push(['sweep', root]); return { removed: [] }; },
      findDataRootRelocationCopy: async (root, relocationId) => { calls.push(['find-copy', root, relocationId]); return copyAside; },
      readDataRootRelocationHold: async (root) => { calls.push(['read-hold', root]); return hold; },
      isDataRootRelocationTargetInvisible: (error) => error?.code === 'data-root-relocation-target-invisible',
      consentToDataRootMovedWork: async (root, relocationId, by) => {
        calls.push(['consent', root, relocationId, by]);
        if (consentError) throw consentError;
        return true;
      },
      undoUnpublishedDataRootRelocation: async (root) => { calls.push(['undo-unpublished', root]); return undoUnpublishedResult; }
    },
    '../../backend/reliableKernel/runtimeExclusiveMaintenance': {
      ...primitive,
      clearExclusiveMaintenanceKey: async (keyPaths, operation, operationKey) => {
        calls.push(['clear-key', operation, operationKey]);
        return primitive.clearExclusiveMaintenanceKey(keyPaths, operation, operationKey);
      }
    },
    '../../backend/reliableKernel/runtimeHostControl': {
      withRuntimeDataRootAdmission: async (root, run) => { calls.push(['admission', root]); return run(); }
    },
    '../../backend/reliableKernel/vscodeRootAuthority': {
      assertConfigurationRootRuntimesOffline: async (root) => { calls.push(['offline', root]); }
    },
    '../../shared/extensionIdentity': {
      EXTENSION_BRAND: 'Limcode test',
      EXTENSION_COMMAND_IDS: { openPanel: 'limcode-test.openPanel' }
    },
    '../dataRootPrompts': {
      askInSettingsPage: async (hostArgument, clientId, prompt) => {
        assert.equal(hostArgument, application);
        assert.equal(clientId, 'client-1');
        prompts.push(plain(prompt));
        calls.push(['prompt', prompt.title]);
        return answers.shift() ?? { choice: 'cancel', include: [] };
      }
    },
  };
  // The real coordination layer; only what reaches it and the operation's stages are recorded.
  const layer = loadSource('vscode/runtimeExclusiveMaintenance.ts', { vscode, '../backend/reliableKernel/runtimeExclusiveMaintenance': primitive });
  dependencies['../runtimeExclusiveMaintenance'] = {
    ...layer,
    runWithExclusiveMaintenance: async (maintenancePaths, options, operation) => {
      calls.push(['exclusive', options]);
      const outcome = await layer.runWithExclusiveMaintenance(maintenancePaths, options, (context) => operation({
        reportStage: (text) => { calls.push(['report-stage', text]); context.reportStage(text); }
      }));
      // E.g. releasing the old directory's claim fails after the operation succeeded.
      if (afterLocksError && outcome.state === 'completed') throw afterLocksError;
      return outcome;
    }
  };
  const commands = loadCommands(dependencies);
  const globalState = new Map();
  const context = {
    globalStorageUri: { fsPath: '/vscode/global-storage' },
    globalState: { get: (key) => globalState.get(key), update: async (key, value) => { calls.push(['global-state', key, value]); globalState.set(key, value); } },
    workspaceState: { get: () => undefined, update: async () => {} }
  };
  const request = { clientId: 'client-1' };
  return {
    calls, abandonOptions, prompts, commands, context, startup, status, request, globalState, progressOptions, cancellation, paths,
    frozen: () => frozen, kinds: () => calls.map((call) => call[0]).filter((kind) => kind !== 'progress')
  };
}

/**
 * Another window of the old directory, as the coordination sees it: its Host liveness record and
 * the real participant (it confirms at once; `busyAtGo`: a task starts right when it is told to go).
 * Told to go, it reloads like extension.ts (leaving, the Runtime closes, the registration goes).
 */
async function openPeer(f, { busyAtGo = false } = {}) {
  const hostBootId = `peer-${crypto.randomUUID()}`;
  const liveness = path.join(hostControl.runtimeHostLivenessDirectory(f.paths), `${hostBootId}.json`);
  fs.mkdirSync(path.dirname(liveness), { recursive: true });
  fs.writeFileSync(liveness, JSON.stringify({
    kind: 'limcode-runtime-host-liveness', dataSetId: 'data-set', rootInstanceId: 'root-instance', rootGeneration: 1, hostBootId,
    livenessId: `${hostBootId}-liveness`, processId: process.pid, processStartIdentity: ownProcessStartIdentity(),
    startedAt: '2026-01-01T00:00:00.000Z', heartbeatAt: new Date().toISOString()
  }));
  const peer = { reloads: 0 };
  const close = async () => {
    await participant.dispose();
    fs.rmSync(liveness, { force: true });
    await participant.unregister();
  };
  const participant = primitive.startExclusiveMaintenanceParticipant(f.paths, hostBootId, {
    busyReason: async (request) => (busyAtGo && request.phase === 'go' ? { kind: 'work', reason: '有任务正在进行' } : undefined),
    confirm: async () => true,
    release: async () => { peer.reloads += 1; await close(); }
  }, { pollMs: 20 });
  await participant.checkNow();
  peer.close = close;
  return peer;
}

const modal = (call) => call[2]?.modal === true || call.slice(2).some((item) => item?.modal === true);

test('迁移成功：确认在设置页 ConfirmPanel 里；先记下迁移进行中并在线准备，锁外等待后倒计时不可否决地重载其它窗口，再查一次本窗口的任务，关闭运行时，最后切换指针', async () => {
  const f = fixture({ answers: [{ choice: 'relocate', include: [] }] });
  await f.commands.relocateDataRoot(f.context, f.startup, f.request);
  // The real primitive: its own-window checks outside and inside the locks, beforeGo (check, freeze,
  // check), the last check, and the operation's own check before it closes the Runtime.
  assert.deepEqual(f.kinds(), [
    'open-dialog', 'plan', 'busy?', 'prompt', 'status', 'stage', 'exclusive', 'busy?', 'locks', 'busy?', 'busy?', 'freeze', 'busy?', 'busy?', 'busy?',
    'report-stage', 'close-runtime', 'complete', 'report-stage', 'status', 'thaw', 'clear-key', 'global-state', 'command'
  ]);
  assert.deepEqual(f.calls.find((call) => call[0] === 'freeze'), ['freeze', '迁移数据目录'], '冻结时说明本窗口在做什么（拒绝写命令的提示用它）');
  // reloc3 #6 / blind #3: only the preparation can be cancelled; nothing after it has a cancel button.
  assert.deepEqual(plain(f.progressOptions).map(({ title, cancellable }) => [title, cancellable]),
    [['正在检查新数据目录…', undefined], ['正在迁移数据目录：准备中（可以取消）', true], ['正在迁移数据目录（已不能取消）', false]]);
  const pendingId = f.calls.find((call) => call[0] === 'status')[1].pendingRelocation.relocationId;
  assert.deepEqual(f.calls.find((call) => call[0] === 'clear-key'), ['clear-key', 'data-root-relocation', `data-root-relocation:${TARGET}#${pendingId}`],
    'reloc3 #6：本次尝试的协调键用完即清，不在账本里累积');
  assert.deepEqual(f.calls.filter((call) => call[0] === 'report-stage').map((call) => call[1]), ['正在关闭本窗口的运行时', '正在切换到新数据目录'],
    '等着打开的窗口看得到阶段（复制与核对的阶段经 onProgress 同样报告）');
  assert.equal(f.calls.find((call) => call[0] === 'plan')[2], true, '行数经本窗口打开的数据库统计');
  const pending = f.calls.find((call) => call[0] === 'status')[1].pendingRelocation;
  assert.deepEqual([pending.sourceRootPath, pending.targetRootPath, pending.processId, pending.processStartIdentity], [SOURCE, TARGET, process.pid, 'start-identity']);
  assert.equal(f.calls.find((call) => call[0] === 'stage')[3], pending.relocationId, '目标里的准备记录与迁移进行记录同一个 id');
  assert.equal(f.calls.find((call) => call[0] === 'exclusive')[1].operationKey, `data-root-relocation:${TARGET}#${pending.relocationId}`,
    '协调的 key 带本次迁移 id：修好原因后再试是新的 key');
  const exclusive = f.calls.find((call) => call[0] === 'exclusive')[1];
  assert.equal(exclusive.participantConfirmation, 'final-countdown');
  assert.equal(exclusive.whenBusy, 'wait');
  assert.equal(exclusive.ignoreBackoff, true);
  assert.equal(exclusive.configurationRootPath, SOURCE);
  assert.equal(exclusive.requesterHostBootId, 'host-1');
  assert.equal(typeof exclusive.withLocks, 'function', '等待在锁外进行，锁只在短轮次里拿');
  assert.equal(typeof exclusive.requesterBusy, 'function', '发起窗口自己的任务也在等待范围内');
  assert.equal(exclusive.windowState, f.context.workspaceState, '本次操作的标识记在本窗口的 workspaceState：失败重载后再点迁移可以越过冷却');
  const published = f.calls.filter((call) => call[0] === 'status')[1][1];
  assert.deepEqual([published.dataRootPath, published.dataRootId, published.pendingRelocation, published.lastMigration.fromPath],
    [TARGET, '00000000-0000-4000-8000-000000000001', null, SOURCE]);
  assert.equal(published.lastMigration.relocationId, pending.relocationId, '指针记下这次迁移的 id：删除旧目录只认这次迁移的完成记录');
  assert.equal(published.expectedPendingRelocationId, pending.relocationId, '只清掉自己的进行中记录');
  assert.equal(f.calls.find((call) => call[0] === 'status')[1].expectedPendingRelocationId, null, '进行中记录只在没有别的迁移时写入');
  assert.ok(!f.calls.some((call) => (call[0] === 'warning' || call[0] === 'error') && modal(call)), '除了选文件夹，没有原生模态框');
  const confirmation = f.prompts[0];
  assert.deepEqual(confirmation.actions.map((action) => action.key), ['cancel', 'relocate']);
  const text = JSON.stringify(confirmation.sections);
  assert.match(text, /旧目录的数据不会被修改/);
  assert.doesNotMatch(text, /原样保留/);
  assert.match(f.globalState.get('limcode.dataRootRelocationNotice'), /1 个历史库留在旧目录/);
  assert.deepEqual(f.calls.at(-1).slice(0, 2), ['command', 'workbench.action.reloadWindow']);
});

test('复审 bulk #6：迁移进度可以取消；在线预复制期间取消时停止准备、清除进行中记录、不协调不重载，提示已取消', async () => {
  const f = fixture({ answers: [{ choice: 'relocate', include: [] }], cancelStage: true });
  await f.commands.relocateDataRoot(f.context, f.startup, f.request);
  assert.deepEqual(plain(f.progressOptions).filter(({ title }) => title.startsWith('正在迁移数据目录')).map(({ title, cancellable }) => [title, cancellable]), [['正在迁移数据目录：准备中（可以取消）', true]]);
  assert.ok(!f.kinds().includes('exclusive') && !f.kinds().includes('close-runtime') && !f.kinds().includes('complete'));
  assert.equal(f.calls.filter((call) => call[0] === 'status').at(-1)[1].pendingRelocation, null);
  assert.match(JSON.stringify(f.prompts.at(-1)), /迁移已取消/);
  assert.equal(f.cancellation.listeners.length, 0, '准备结束后不再监听取消');
  assert.ok(!f.calls.some((call) => call[0] === 'command'));
});

test('发起窗口在等待期间有任务：只提示一次迁移会推迟，在锁外等它结束（这期间不冻结），之后照常迁移（盲审 #7：与真实原语一致）', async () => {
  let checks = 0;
  // Idle when the user confirms, then busy for three checks.
  const f = fixture({ answers: [{ choice: 'relocate', include: [] }], busy: () => { checks += 1; return checks >= 2 && checks <= 4; } });
  await f.commands.relocateDataRoot(f.context, f.startup, f.request);
  assert.equal(f.calls.filter((call) => call[0] === 'info' && /会等它结束后再进行/.test(call[1])).length, 1);
  const kinds = f.kinds();
  assert.ok(kinds.lastIndexOf('busy?') > kinds.indexOf('exclusive') + 3, 'waited while busy');
  assert.equal(kinds.filter((kind) => kind === 'freeze').length, 1, '只在空闲之后冻结一次');
  assert.ok(kinds.includes('complete') && !kinds.includes('abandon'));
  assert.deepEqual(plain(f.progressOptions).map(({ title, cancellable }) => [title, cancellable]), [
    ['正在检查新数据目录…', undefined], ['正在迁移数据目录：准备中（可以取消）', true], ['正在迁移数据目录（已不能取消）', false],
    ['迁移数据目录：正在等待 LimCode 窗口空闲', false]
  ], '等待本窗口时的通知也不能取消');
  assert.deepEqual(f.calls.at(-1).slice(0, 2), ['command', 'workbench.action.reloadWindow']);
});

test('beforeGo 冻结之后的复查：检查与冻结之间开始的任务或复查本身出错都按忙处理——解冻、放开锁回锁外继续等，之后照常迁移，窗口不会一直冻结（盲审 #7）', async () => {
  for (const late of [true, new Error('探测失败')]) {
    let frozenChecks = 0;
    const f = fixture({ answers: [{ choice: 'relocate', include: [] }], busy: ({ frozen }) => (frozen && (frozenChecks += 1) === 1 ? late : false) });
    await f.commands.relocateDataRoot(f.context, f.startup, f.request);
    assert.deepEqual(f.kinds().filter((kind) => ['freeze', 'thaw', 'close-runtime', 'locks'].includes(kind)),
      ['locks', 'freeze', 'thaw', 'locks', 'freeze', 'close-runtime', 'thaw']);
    assert.equal(f.frozen(), 0);
    assert.ok(f.kinds().includes('complete') && !f.kinds().includes('abandon'));
    assert.deepEqual(f.calls.at(-1).slice(0, 2), ['command', 'workbench.action.reloadWindow']);
  }
});

test('盲审 #3：进入协调后没有可以取消的通知——等其它窗口时的通知也不能取消；其它窗口按 go 重载后迁移照常完成', async () => {
  const f = fixture({ answers: [{ choice: 'relocate', include: [] }] });
  const peer = await openPeer(f);
  try {
    await f.commands.relocateDataRoot(f.context, f.startup, f.request);
  } finally {
    await peer.close();
  }
  assert.equal(peer.reloads, 1);
  assert.ok(f.kinds().includes('complete'));
  assert.deepEqual(plain(f.progressOptions).map(({ title, cancellable }) => [title, cancellable]), [
    ['正在检查新数据目录…', undefined], ['正在迁移数据目录：准备中（可以取消）', true], ['正在迁移数据目录（已不能取消）', false],
    ['迁移数据目录：正在等待 LimCode 窗口空闲', false]
  ]);
  assert.equal(f.cancellation.listeners.length, 0, '协调阶段没有任何取消监听');
  assert.deepEqual(f.calls.at(-1).slice(0, 2), ['command', 'workbench.action.reloadWindow']);
});

test('其它窗口没有让出（go 之后又开始了任务）：撤销准备、清除进行中记录，本窗口继续使用原目录且不重载，原因显示在设置页', async () => {
  const f = fixture({ answers: [{ choice: 'relocate', include: [] }] });
  const peer = await openPeer(f, { busyAtGo: true });
  try {
    await f.commands.relocateDataRoot(f.context, f.startup, f.request);
  } finally {
    await peer.close();
  }
  assert.deepEqual(f.calls.find((call) => call[0] === 'abandon'), ['abandon', true]);
  assert.ok(!f.kinds().includes('close-runtime'));
  assert.equal(peer.reloads, 0);
  assert.equal(f.calls.filter((call) => call[0] === 'status').at(-1)[1].pendingRelocation, null);
  assert.match(JSON.stringify(f.prompts.at(-1)), /其它窗口开始让出后1 个其它窗口有任务正在进行/);
  assert.ok(!f.calls.some((call) => call[0] === 'command'));
});

test('运行时关闭后迁移失败：迁移自身已撤销时不再重复；没能撤销时再撤销一次，仍失败就保留进行中记录留给下次启动；关闭运行时本身失败也会撤销', async () => {
  const cleaned = fixture({ answers: [{ choice: 'relocate', include: [] }], completeError: new Error('同一条记录内容不同'), cleanup: 'cleaned' });
  await cleaned.commands.relocateDataRoot(cleaned.context, cleaned.startup, cleaned.request);
  assert.ok(!cleaned.kinds().includes('abandon'));
  assert.equal(cleaned.calls.filter((call) => call[0] === 'status').at(-1)[1].pendingRelocation, null);
  const error = cleaned.calls.find((call) => call[0] === 'error');
  assert.equal(error[2].modal, true, '设置页已随运行时关闭，只能用原生提示');
  assert.match(error[2].detail, /同一条记录内容不同/);
  assert.match(error[2].detail, /已撤销/);
  assert.deepEqual(cleaned.calls.at(-1).slice(0, 2), ['command', 'workbench.action.reloadWindow']);

  const stuck = fixture({
    answers: [{ choice: 'relocate', include: [] }], completeError: new Error('磁盘错误'), cleanup: 'not-cleaned', abandonError: new Error('仍然失败')
  });
  await stuck.commands.relocateDataRoot(stuck.context, stuck.startup, stuck.request);
  assert.ok(stuck.kinds().includes('abandon'));
  assert.equal(stuck.calls.filter((call) => call[0] === 'status').length, 1, '进行中记录保留，下次启动再撤销');
  assert.match(stuck.calls.find((call) => call[0] === 'error')[2].detail, /下次启动 LimCode 时会再撤销一次/);

  const closeFailed = fixture({ answers: [{ choice: 'relocate', include: [] }], closeError: new Error('关闭失败') });
  await closeFailed.commands.relocateDataRoot(closeFailed.context, closeFailed.startup, closeFailed.request);
  assert.ok(!closeFailed.kinds().includes('complete'));
  assert.ok(closeFailed.kinds().includes('abandon'), '准备阶段留下的内容由命令撤销，不会谎称已清理');
});

test('reloc3 问题 2 与撤销搁置：失败后拷来的数据仍在旁边就不算撤销完，保留进行中记录并写明拷贝位置；撤销被搁置时清除记录并说明备份在哪；启动时搁置的续撤同样处理；打开搁置的目录提示一次，可以不再提醒', async () => {
  const aside = `${TARGET}.limcode-copied-2026-09-27T00-00-00-000Z-12345678`;
  const copied = fixture({ answers: [{ choice: 'relocate', include: [] }], completeError: new Error('同一条记录内容不同'), cleanup: 'cleaned', copyAside: aside });
  await copied.commands.relocateDataRoot(copied.context, copied.startup, copied.request);
  const relocationId = copied.calls.find((call) => call[0] === 'status')[1].pendingRelocation.relocationId;
  assert.deepEqual(copied.calls.find((call) => call[0] === 'find-copy').slice(1), [TARGET, relocationId]);
  assert.equal(copied.calls.filter((call) => call[0] === 'status').length, 1, '拷贝还在旁边：进行中记录保留，下次启动再改回');
  const detail = copied.calls.find((call) => call[0] === 'error')[2].detail;
  assert.match(detail, /没能全部撤销/);
  assert.ok(detail.includes(aside), detail);

  const heldMessage = '新数据目录里的当前历史库在这次迁移之后有了新的内容。为了不覆盖这些内容，那次迁移在新目录里做的改动没有撤销；迁移前的数据库副本保存在 /data/new-home/.limcode-relocation-backups/x。';
  const heldError = Object.assign(new Error(heldMessage), { code: 'data-root-relocation-undo-held' });
  const held = fixture({ answers: [{ choice: 'relocate', include: [] }], completeError: new Error('磁盘错误'), cleanup: 'not-cleaned', abandonError: heldError });
  await held.commands.relocateDataRoot(held.context, held.startup, held.request);
  assert.equal(held.calls.filter((call) => call[0] === 'status').at(-1)[1].pendingRelocation, null, '搁置：不会再自动撤销，没有要留给下次启动的');
  const heldDetail = held.calls.find((call) => call[0] === 'error')[2].detail;
  assert.ok(heldDetail.includes(heldMessage), heldDetail);
  assert.doesNotMatch(heldDetail, /下次启动 LimCode 时会再撤销一次/);

  const pending = { relocationId: 'r-1', sourceRootPath: SOURCE, targetRootPath: TARGET, startedAt: 'x', processId: 1 };
  const hold = { relocationId: 'r-1', message: heldMessage };
  const startup = fixture({ pendingRelocation: pending, ownerState: 'dead', recoverOutcome: 'held', hold });
  assert.equal(await startup.commands.beforeDataRootOpen(startup.context), undefined);
  assert.equal(startup.calls.find((call) => call[0] === 'status')[1].pendingRelocation, null);
  assert.ok(startup.calls.some((call) => call[0] === 'warning' && call[1].includes('上次中断的数据目录迁移没有撤销') && call[1].includes(heldMessage)));

  const opened = fixture({ hold, nativeAnswers: ['不再提醒'] });
  await opened.commands.afterDataRootOpened(opened.context, TARGET);
  await new Promise(setImmediate);
  const warning = opened.calls.find((call) => call[0] === 'warning');
  assert.ok(warning[1].includes('这个数据目录里有一次没有撤销的迁移') && warning[1].includes(heldMessage), warning[1]);
  assert.equal(warning[2], '不再提醒', '不是模态：不阻塞使用');
  assert.deepEqual(plain(opened.globalState.get('limcode.dataRootHeldRelocationDismissed')), ['r-1']);
  await opened.commands.afterDataRootOpened(opened.context, TARGET);
  await new Promise(setImmediate);
  assert.equal(opened.calls.filter((call) => call[0] === 'warning').length, 1, '不再提醒');
});

test('命令面板入口打开设置页；本窗口有任务、预检不通过、另一个迁移进行中或取消确认时不开始迁移', async () => {
  const palette = fixture();
  await palette.commands.relocateDataRoot(palette.context, palette.startup);
  assert.deepEqual(plain(palette.calls[0]), ['command', 'limcode-test.openPanel', { kind: 'globalSettings', reuse: true }]);
  assert.ok(!palette.kinds().includes('open-dialog'));

  const busy = fixture({ busy: [true] });
  await busy.commands.relocateDataRoot(busy.context, busy.startup, busy.request);
  assert.ok(!busy.kinds().includes('stage'));
  assert.equal(busy.prompts[0].title, '本窗口有任务正在进行');

  const refused = fixture({ plan: { problems: ['当前历史库数据较多（约 30000 行记录）'] } });
  await refused.commands.relocateDataRoot(refused.context, refused.startup, refused.request);
  assert.ok(!refused.kinds().includes('stage') && !refused.kinds().includes('exclusive'), '行数超限在任何协调之前拒绝');
  assert.match(JSON.stringify(refused.prompts[0]), /数据较多/);

  const running = fixture({ pendingRelocation: { relocationId: 'r', sourceRootPath: SOURCE, targetRootPath: TARGET, startedAt: 'x', processId: 1 }, ownerState: 'alive' });
  await running.commands.relocateDataRoot(running.context, running.startup, running.request);
  assert.ok(!running.kinds().includes('open-dialog'));
  assert.equal(running.prompts[0].title, '已有迁移正在进行');

  const cancelled = fixture({ answers: [{ choice: 'cancel', include: [] }] });
  await cancelled.commands.relocateDataRoot(cancelled.context, cancelled.startup, cancelled.request);
  assert.ok(!cancelled.kinds().includes('stage') && !cancelled.kinds().includes('status'));
});

test('所选文件夹里已有其它文件：只能用新建的子文件夹，完整列出已有内容，按子文件夹重新预检', async () => {
  const entries = Array.from({ length: 20 }, (_, index) => `file-${index}.txt`);
  const nested = path.join(TARGET, 'LimCode');
  const f = fixture({
    plan: (target) => (target === TARGET ? { target: { kind: 'occupied', entries, suggestedPath: nested }, problems: ['已有其它文件'] } : {}),
    answers: [{ choice: 'nested', include: [] }, { choice: 'relocate', include: [] }]
  });
  await f.commands.relocateDataRoot(f.context, f.startup, f.request);
  assert.deepEqual(f.calls.filter((call) => call[0] === 'plan').map((call) => call[1]), [TARGET, nested]);
  assert.deepEqual(f.prompts[0].sections[0].lines, entries, '清单完整，不截断');
  assert.deepEqual(f.prompts[0].actions.map((action) => action.key), ['cancel', 'nested'], '没有“直接使用所选文件夹”');
  assert.equal(f.calls.find((call) => call[0] === 'stage')[1], nested);
});

test('删除旧目录：完整列出将删除与保留的内容，备份默认不删只有勾选才删，确认的清单原样交给删除', async () => {
  const lastMigration = { fromPath: '/vscode/global-storage', toPath: SOURCE, migratedAt: '2026-09-26T00:00:00.000Z' };
  const kept = Array.from({ length: 15 }, (_, index) => ({ name: `user-${index}`, reason: '不是 LimCode 迁移的数据，保留' }));
  const items = [
    { key: 'data-set:default', kind: 'data-set', label: '历史库 default', paths: [], bytes: 4096, optional: false, deletable: true },
    { key: 'data-set:workspace:x', kind: 'data-set', label: '历史库 workspace:x', paths: [], bytes: 10, optional: false, deletable: false, reason: '迁移之后这个历史库有新的改动' },
    { key: 'configuration:agents', kind: 'configuration', label: '设置 agents', paths: [], bytes: 100, optional: false, deletable: true },
    { key: 'backup:default:merge-backups', kind: 'backup', label: '历史库 default 的合并前备份', paths: [], bytes: 2048, optional: true, deletable: true },
    { key: 'backup:default:.limcode-runtime-backups', kind: 'backup', label: '归档', paths: [], bytes: 999, optional: true, deletable: true }
  ];
  const f = fixture({
    lastMigration, deletion: { items, kept },
    answers: [{ choice: 'delete', include: ['backup:default:merge-backups'] }, { choice: 'cancel', include: [] }],
    deleteResult: { removed: ['configuration:agents', 'data-set:default', 'backup:default:merge-backups'], remainingDataSets: 1 }
  });
  await f.commands.deletePreviousDataRoot(f.context, f.startup, f.request);
  assert.deepEqual(f.calls.find((call) => call[0] === 'plan-delete')[1].keepEntries, ['.limcode-global-status.json'], 'VS Code 默认目录保留数据目录指针文件');
  const prompt = f.prompts[0];
  assert.equal(prompt.danger, true);
  const text = JSON.stringify(prompt.sections);
  for (const entry of kept) assert.ok(text.includes(entry.name), `保留清单完整：${entry.name}`);
  assert.match(text, /历史库 workspace:x：迁移之后这个历史库有新的改动/);
  assert.deepEqual(prompt.options.map((option) => option.key), ['backup:default:merge-backups', 'backup:default:.limcode-runtime-backups']);
  assert.match(prompt.options[0].label, /2048 B/, '勾选项写明大小');
  const deleted = f.calls.find((call) => call[0] === 'delete')[1];
  assert.deepEqual(deleted.include, ['backup:default:merge-backups']);
  assert.deepEqual(deleted.confirmedKeys, ['data-set:default', 'configuration:agents', 'backup:default:merge-backups']);
  assert.ok(!f.calls.some((call) => call[0] === 'status'), '旧目录还有保留的历史库：继续显示旧目录');

  const refused = fixture({ lastMigration, deletion: { problems: ['找不到从这个目录迁移完成的记录'] } });
  await refused.commands.deletePreviousDataRoot(refused.context, refused.startup, refused.request);
  assert.ok(!refused.kinds().includes('delete'));
  assert.match(JSON.stringify(refused.prompts[0]), /找不到/);

  const emptied = fixture({ lastMigration, deletion: { items: items.slice(0, 1) }, answers: [{ choice: 'delete', include: [] }] });
  await emptied.commands.deletePreviousDataRoot(emptied.context, emptied.startup, emptied.request);
  assert.equal(emptied.calls.find((call) => call[0] === 'status')[1].lastMigration, null, '旧目录没有历史库了：不再显示');
});

test('删除旧目录后旧目录里还留着“归档并重置”的归档：继续记住旧目录（归档经它列在外来历史库里），并说明还保留几份', async () => {
  const lastMigration = { fromPath: '/vscode/global-storage', toPath: SOURCE, migratedAt: '2026-09-26T00:00:00.000Z' };
  const items = [
    { key: 'data-set:default', kind: 'data-set', label: '历史库 default', paths: [], bytes: 4096, optional: false, deletable: true },
    { key: 'backup:workspace:x:.limcode-runtime-backups', kind: 'backup', label: '历史库 workspace:x 的“归档并重置”归档', paths: [], bytes: 999, optional: true, deletable: true }
  ];
  const archived = fixture({
    lastMigration, deletion: { items }, answers: [{ choice: 'delete', include: [] }, { choice: 'ok', include: [] }],
    deleteResult: { removed: ['data-set:default'], remainingDataSets: 0, remainingArchives: 2 }
  });
  await archived.commands.deletePreviousDataRoot(archived.context, archived.startup, archived.request);
  assert.ok(!archived.calls.some((call) => call[0] === 'status'), '旧目录里还有归档：不清空 lastMigration');
  assert.match(JSON.stringify(archived.prompts.at(-1)), /还保留 2 份“归档并重置”留下的归档，列在“历史与存储管理 → 外来历史库”里，设置页仍会显示这个旧目录/);

  const unreadable = fixture({
    lastMigration,
    deletion: { items: [{ key: 'backup:workspace:y:.limcode-runtime-backups', kind: 'backup', label: '归档', paths: [], bytes: 0, optional: true, deletable: false, reason: '无法读取，保留' }] }
  });
  await unreadable.commands.deletePreviousDataRoot(unreadable.context, unreadable.startup, unreadable.request);
  assert.ok(!unreadable.kinds().includes('delete'));
  assert.ok(!unreadable.calls.some((call) => call[0] === 'status'), '只剩保留的归档目录（无法读取）：同样不忘记旧目录');

  const cleared = fixture({
    lastMigration, deletion: { items }, answers: [{ choice: 'delete', include: ['backup:workspace:x:.limcode-runtime-backups'] }],
    deleteResult: { removed: ['backup:workspace:x:.limcode-runtime-backups', 'data-set:default'], remainingDataSets: 0, remainingArchives: 0 }
  });
  await cleared.commands.deletePreviousDataRoot(cleared.context, cleared.startup, cleared.request);
  assert.equal(cleared.calls.find((call) => call[0] === 'status')[1].lastMigration, null, '归档也删了：不再显示旧目录');
});

test('数据目录不可用：可以重试、回到旧目录、选择其它已有目录或改用默认目录（二次确认）', async () => {
  const lastMigration = { fromPath: SOURCE, toPath: '/mnt/usb/limcode', migratedAt: '2026-09-26T00:00:00.000Z' };
  const retry = fixture({ host: false, lastMigration, recoveryChoice: '重试' });
  retry.status.dataRootPath = '/mnt/usb/limcode';
  await retry.commands.offerDataRootRecovery(retry.context, retry.startup, '数据目录不可用');
  assert.deepEqual(retry.calls.find((call) => call[0] === 'error').slice(2), ['重试', '回到旧目录', '选择其它目录…', '使用默认目录…']);

  const noPrevious = fixture({ host: false, recoveryChoice: undefined });
  await noPrevious.commands.offerDataRootRecovery(noPrevious.context, noPrevious.startup, '数据目录不可用');
  assert.deepEqual(noPrevious.calls.find((call) => call[0] === 'error').slice(2), ['重试', '选择其它目录…', '使用默认目录…']);

  // reloc3 #4: an error that retrying will not fix (no permission, a path that became a file): the other ways out are offered too.
  const stuck = fixture({ host: false, recoveryChoice: undefined });
  await stuck.commands.offerDataRootRecovery(stuck.context, stuck.startup, '数据目录不可用', 'inaccessible');
  assert.deepEqual(stuck.calls.find((call) => call[0] === 'error').slice(2), ['重试', '选择其它目录…', '使用默认目录…']);
  // Blind review C: temporary (a relocation into the directory runs or waits for its windows, a read
  // that usually passes): only "重试", never a way that points elsewhere meanwhile.
  for (const reason of ['relocating', 'unreadable']) {
    const waiting = fixture({ host: false, recoveryChoice: '重试' });
    await waiting.commands.offerDataRootRecovery(waiting.context, waiting.startup, '数据目录不可用', reason);
    const offered = waiting.calls.find((call) => call[0] === 'error');
    assert.deepEqual(offered.slice(2), ['重试'], reason);
    assert.match(offered[1], reason === 'relocating' ? /迁移完成或撤销之后就能打开/ : /通常是暂时的/);
    assert.deepEqual(waiting.calls.at(-1).slice(0, 2), ['command', 'workbench.action.reloadWindow']);
    assert.ok(!waiting.kinds().includes('status'));
  }
  // Blind review A: another installation's relocation copied its data in and never switched, its process gone: the user decides.
  const later = fixture({ host: false, recoveryChoice: '暂不打开' });
  await later.commands.offerDataRootRecovery(later.context, later.startup, '数据目录暂时没有打开', 'unpublished');
  assert.deepEqual(later.calls.find((call) => call[0] === 'error').slice(2), ['撤销那次未完成的迁移并打开', '暂不打开']);
  assert.ok(!later.kinds().includes('undo-unpublished') && !later.kinds().includes('command'), '暂不打开：什么都不动');
  const undo = fixture({ host: false, recoveryChoice: '撤销那次未完成的迁移并打开' });
  undo.status.dataRootPath = TARGET;
  await undo.commands.offerDataRootRecovery(undo.context, undo.startup, '数据目录暂时没有打开', 'unpublished');
  assert.deepEqual(undo.calls.find((call) => call[0] === 'undo-unpublished'), ['undo-unpublished', TARGET]);
  assert.deepEqual(undo.calls.at(-1).slice(0, 2), ['command', 'workbench.action.reloadWindow']);
  const kept = fixture({ host: false, recoveryChoice: '撤销那次未完成的迁移并打开', undoUnpublishedResult: { held: '之后有人写过。' } });
  await kept.commands.offerDataRootRecovery(kept.context, kept.startup, '数据目录暂时没有打开', 'unpublished');
  assert.match(kept.calls.find((call) => call[0] === 'warning')[2].detail, /之后有人写过。[\s\S]*照常打开/);

  // reloc3 #6: the unavailable directory's data was moved (its notice stays after the old data is deleted): "改用迁移后的目录".
  const movedAway = fixture({
    host: false, recoveryChoice: '改用迁移后的目录', nativeAnswers: ['改用并重载'],
    movedNotice: { targetRootPath: '/mnt/new/limcode', relocationId: 'r-9', movedAt: '2026-09-26T08:30:00.000Z', installation: { id: '/other/installation', label: 'VS Code（b）' } }
  });
  movedAway.status.dataRootPath = '/mnt/usb/limcode';
  await movedAway.commands.offerDataRootRecovery(movedAway.context, movedAway.startup, '数据目录不可用', 'empty');
  const offered = movedAway.calls.find((call) => call[0] === 'error');
  assert.match(offered[1], /已在 2026-09-26 08:30 由 VS Code（b） 迁移到 \/mnt\/new\/limcode/);
  assert.deepEqual(offered.slice(2), ['重试', '改用迁移后的目录', '选择其它目录…', '使用默认目录…']);
  assert.equal(movedAway.calls.find((call) => call[0] === 'status')[1].dataRootPath, '/mnt/new/limcode');
  assert.equal(movedAway.calls.find((call) => call[0] === 'status')[1].lastMigration.relocationId, undefined, '只切换、不作删除依据');

  const other = fixture({ host: false, recoveryChoice: '选择其它目录…', picked: '/mnt/other/limcode', nativeAnswers: ['切换并重载'] });
  other.status.dataRootPath = '/mnt/usb/limcode';
  await other.commands.offerDataRootRecovery(other.context, other.startup, '数据目录不可用');
  assert.deepEqual(other.calls.find((call) => call[0] === 'identity'), ['identity', '/mnt/other/limcode']);
  const switched = other.calls.find((call) => call[0] === 'status')[1];
  assert.deepEqual([switched.dataRootPath, switched.dataRootId, switched.lastMigration.fromPath], ['/mnt/other/limcode', '00000000-0000-4000-8000-000000000002', '/mnt/usb/limcode']);

  const unusable = fixture({ host: false, recoveryChoice: '选择其它目录…', picked: '/mnt/empty', returnUsable: false });
  await unusable.commands.offerDataRootRecovery(unusable.context, unusable.startup, '数据目录不可用');
  assert.ok(!unusable.kinds().includes('status'), '不是 LimCode 数据目录时不切换');

  const declined = fixture({ host: false, recoveryChoice: '使用默认目录…', nativeAnswers: [undefined] });
  await declined.commands.offerDataRootRecovery(declined.context, declined.startup, '数据目录不可用');
  assert.ok(!declined.kinds().includes('status'), '改用默认目录要二次确认');
  const fallback = fixture({ host: false, recoveryChoice: '使用默认目录…', nativeAnswers: ['改用默认目录并重载'], returnUsable: false });
  fallback.status.dataRootPath = '/mnt/usb/limcode';
  await fallback.commands.offerDataRootRecovery(fallback.context, fallback.startup, '数据目录不可用');
  const warning = fallback.calls.find((call) => call[0] === 'warning');
  assert.match(warning[2].detail, /新建一份空的历史/);
  const fallbackStatus = fallback.calls.find((call) => call[0] === 'status')[1];
  assert.deepEqual([fallbackStatus.dataRootPath, fallbackStatus.dataRootId], ['', null]);
  assert.equal(fallbackStatus.lastMigration.relocationId, undefined, '只切换、没复制：这条记录永远不能作删除依据');
  assert.deepEqual(fallback.calls.at(-1).slice(0, 2), ['command', 'workbench.action.reloadWindow']);
  assert.equal(switched.lastMigration.relocationId, undefined, '选择其它目录同样不记迁移 id');

  // reloc2 #6: the default directory already holds (older) data: said so before switching.
  const older = fixture({ host: false, recoveryChoice: '使用默认目录…', nativeAnswers: [undefined] });
  older.status.dataRootPath = '/mnt/usb/limcode';
  await older.commands.offerDataRootRecovery(older.context, older.startup, '数据目录不可用');
  assert.match(older.calls.find((call) => call[0] === 'warning')[2].detail, /默认目录里已经有 LimCode 数据：那是以前留在那里的旧历史/);
  // ... and when the data came from the default directory, the way back is "回到旧目录".
  const moved = fixture({
    host: false, recoveryChoice: '使用默认目录…', nativeAnswers: [undefined],
    lastMigration: { fromPath: '/vscode/global-storage', toPath: '/mnt/usb/limcode', migratedAt: '2026-09-26T00:00:00.000Z', relocationId: 'r' }
  });
  moved.status.dataRootPath = '/mnt/usb/limcode';
  await moved.commands.offerDataRootRecovery(moved.context, moved.startup, '数据目录不可用');
  const guide = moved.calls.find((call) => call[0] === 'warning');
  assert.deepEqual([guide[1], guide[3]], ['默认目录就是迁移前的旧目录', ['回到旧目录']]);
  assert.ok(!moved.kinds().includes('status'), '没有直接改用默认目录');

  // reloc2 #13: a directory that merely could not be read right now is only retried.
  const flaky = fixture({ host: false, lastMigration, recoveryChoice: undefined });
  flaky.status.dataRootPath = '/mnt/usb/limcode';
  await flaky.commands.offerDataRootRecovery(flaky.context, flaky.startup, '数据目录不可用', 'unreadable');
  const flakyPrompt = flaky.calls.find((call) => call[0] === 'error');
  assert.deepEqual(flakyPrompt.slice(2), ['重试']);
  assert.match(flakyPrompt[1], /暂时的.*稍后重试/);
});

test('回到旧目录：运行时正常时经独占协调（倒计时不可否决）后让当前目录的迁移记录失效，再只切换指针；当前目录不可达时不在它上面拿锁', async () => {
  const lastMigration = { fromPath: '/data/older', toPath: SOURCE, migratedAt: '2026-09-26T00:00:00.000Z' };
  const f = fixture({ lastMigration, answers: [{ choice: 'return', include: [] }] });
  await f.commands.returnToPreviousDataRoot(f.context, f.startup, f.request);
  assert.match(JSON.stringify(f.prompts[0]), /不复制也不合并/);
  assert.equal(f.calls.find((call) => call[0] === 'exclusive')[1].participantConfirmation, 'final-countdown');
  assert.equal(f.calls.find((call) => call[0] === 'exclusive')[1].windowState, f.context.workspaceState);
  const order = f.kinds();
  assert.ok(order.indexOf('close-runtime') < order.indexOf('invalidate') && order.indexOf('invalidate') < order.indexOf('status'));
  assert.deepEqual(f.calls.find((call) => call[0] === 'invalidate'), ['invalidate', SOURCE]);
  const status = f.calls.find((call) => call[0] === 'status')[1];
  assert.deepEqual([status.dataRootPath, status.dataRootId, status.lastMigration.fromPath], ['/data/older', '00000000-0000-4000-8000-000000000002', SOURCE]);
  assert.ok(!f.kinds().includes('stage') && !f.kinds().includes('complete'));
  assert.deepEqual(f.calls.filter((call) => call[0] === 'report-stage').map((call) => call[1]), ['正在关闭本窗口的运行时', '正在切换回旧数据目录']);
  assert.ok(order.indexOf('freeze') < order.indexOf('close-runtime'), '关闭运行时之前先冻结本窗口');
  assert.deepEqual(f.calls.find((call) => call[0] === 'clear-moved'), ['clear-moved', '/data/older', '/vscode/global-storage'],
    'reloc3 C11：回到旧目录时清掉本安装在那里留下的“已迁走”标记');
  assert.equal(f.calls.find((call) => call[0] === 'clear-key')?.[1], 'data-root-return', '本次协调的键用完即清');

  const unreachable = fixture({ host: false, lastMigration: { ...lastMigration, toPath: '/mnt/usb/limcode' }, currentAvailable: false, nativeAnswers: ['回到旧目录'] });
  unreachable.status.dataRootPath = '/mnt/usb/limcode';
  await unreachable.commands.returnToPreviousDataRoot(unreachable.context, unreachable.startup);
  assert.ok(!unreachable.kinds().includes('admission') && !unreachable.kinds().includes('invalidate'));
  assert.equal(unreachable.calls.find((call) => call[0] === 'status')[1].dataRootPath, '/data/older');
});

test('启动前：迁移进程还在时显示“正在迁移数据目录”；进程已结束时先撤销它在新目录里的准备再清除记录；打开后收尾、清理临时副本并显示一次结果', async () => {
  const pending = { relocationId: 'r-1', sourceRootPath: SOURCE, targetRootPath: TARGET, startedAt: 'x', processId: 1 };
  const running = fixture({ pendingRelocation: pending, ownerState: 'alive' });
  assert.equal(await running.commands.beforeDataRootOpen(running.context), '正在迁移数据目录，完成后自动打开');
  assert.ok(!running.kinds().includes('recover'));

  const crashed = fixture({ pendingRelocation: pending, ownerState: 'dead' });
  assert.equal(await crashed.commands.beforeDataRootOpen(crashed.context), undefined);
  assert.deepEqual(crashed.calls.find((call) => call[0] === 'recover')[1], { targetRootPath: TARGET, relocationId: 'r-1' });
  assert.equal(crashed.calls.find((call) => call[0] === 'status')[1].pendingRelocation, null);

  const unreachable = fixture({ pendingRelocation: pending, ownerState: 'dead', recoverOutcome: 'unreachable' });
  await unreachable.commands.beforeDataRootOpen(unreachable.context);
  assert.ok(!unreachable.kinds().includes('status'), '新目录不可达：记录保留，下次再撤销');

  const opened = fixture();
  opened.globalState.set('limcode.dataRootRelocationNotice', '数据目录已迁移');
  await opened.commands.afterDataRootOpened(opened.context, TARGET);
  assert.deepEqual(opened.kinds(), ['finalize', 'sweep', 'global-state', 'info', 'read-hold', 'read-moved']);
  await opened.commands.afterDataRootOpened(opened.context, TARGET);
  assert.equal(opened.calls.filter((call) => call[0] === 'info').length, 1, '结果只显示一次');

  // reloc2 #10: a crashed relocation must be undone before a new one starts; its record stays until then.
  const blocked = fixture({ pendingRelocation: pending, ownerState: 'dead', recoverOutcome: 'blocked', answers: [{ choice: 'cancel', include: [] }] });
  await blocked.commands.relocateDataRoot(blocked.context, blocked.startup, blocked.request);
  assert.deepEqual(blocked.kinds(), ['recover', 'prompt']);
  assert.match(JSON.stringify(blocked.prompts[0]), /上次中断的数据目录迁移还没有撤销完/);
});

test('盲审 #9：另一个窗口上次的迁移失败、撤销没做完（发起进程仍在）时不说“正在迁移”：启动时只警告，迁移命令说明要先撤销；发起进程状态无法确认时启动不宣布', async () => {
  const target = path.join(WORK, 'unfinished-target');
  fs.mkdirSync(target, { recursive: true });
  const markerPath = path.join(target, '.limcode-data-root-relocation.json');
  const relocationId = '00000000-0000-4000-8000-0000000000a9';
  const pending = { relocationId, sourceRootPath: SOURCE, targetRootPath: target, startedAt: 'x', processId: 1 };
  const marker = (state) => fs.writeFileSync(markerPath, JSON.stringify({ relocationId, state, targetRootPath: target }));
  const warnings = (f) => f.calls.filter((call) => call[0] === 'warning').map((call) => call[1]);
  // Still moving data: announced, nothing else.
  marker('staging');
  const moving = fixture({ pendingRelocation: pending, ownerState: 'alive' });
  assert.equal(await moving.commands.beforeDataRootOpen(moving.context), '正在迁移数据目录，完成后自动打开');
  assert.deepEqual(warnings(moving), []);
  // Failed, being undone or its undo not finished (an undo marks a staging record 'undoing' too): nothing to wait for; warned; never undone under its live process.
  marker('undoing');
  const undoing = fixture({ pendingRelocation: pending, ownerState: 'alive' });
  assert.equal(await undoing.commands.beforeDataRootOpen(undoing.context), undefined);
  assert.ok(!undoing.kinds().includes('recover'));
  assert.deepEqual(warnings(undoing), [`Limcode test：另一个 LimCode 窗口迁移数据目录没有成功，它在新目录（${target}）里的改动正在撤销或还没有撤销完；`
    + '这里照常打开原来的数据目录；如果那个窗口的撤销停下了，关闭或重载那个窗口后会自动处理。']);
  const command = fixture({ pendingRelocation: pending, ownerState: 'alive' });
  await command.commands.relocateDataRoot(command.context, command.startup, command.request);
  assert.ok(!command.kinds().includes('open-dialog'));
  assert.equal(command.prompts[0].title, '上次的迁移没有成功，还没有撤销完');
  assert.match(JSON.stringify(command.prompts[0]), /另一个 LimCode 窗口迁移数据目录没有成功.*正在撤销或还没有撤销完；等它撤销完之后才能开始新的迁移；如果撤销停下了，在那个窗口里再点一次“迁移数据目录”/);
  // Its record already gone but the copy it renamed aside still beside the target: not undone either.
  fs.rmSync(markerPath);
  const aside = fixture({ pendingRelocation: pending, ownerState: 'alive', copyAside: `${target}.limcode-copied-1` });
  assert.equal(await aside.commands.beforeDataRootOpen(aside.context), undefined);
  assert.equal(warnings(aside).length, 1);
  // The process cannot be confirmed: not announced as migrating.
  marker('staging');
  const unknown = fixture({ pendingRelocation: pending, ownerState: 'unknown' });
  assert.equal(await unknown.commands.beforeDataRootOpen(unknown.context), undefined);
  assert.ok(!unknown.kinds().includes('warning') && !unknown.kinds().includes('recover'));
  // Still moving data: the command says so as before.
  const busy = fixture({ pendingRelocation: pending, ownerState: 'alive' });
  await busy.commands.relocateDataRoot(busy.context, busy.startup, busy.request);
  assert.equal(busy.prompts[0].title, '已有迁移正在进行');
});

test('另一个安装把这个目录的数据迁走了（reloc2 #7）：打开时不阻塞地警告会分叉，可以改用新目录或不再提醒；本安装自己的标记直接清掉', async () => {
  const notice = {
    targetRootPath: '/data/moved-by-other', relocationId: 'r-other', movedAt: '2026-09-27T01:02:03.000Z',
    installation: { id: '/other/vscode/global-storage', label: 'VS Code（desk）' }
  };
  const dismiss = fixture({ movedNotice: notice, nativeAnswers: ['不再提醒'] });
  await dismiss.commands.afterDataRootOpened(dismiss.context, SOURCE, dismiss.startup);
  await new Promise(setImmediate);
  const warning = dismiss.calls.find((call) => call[0] === 'warning');
  assert.match(warning[1], /另一个 LimCode 安装（VS Code（desk））迁移到 \/data\/moved-by-other。继续在这里使用，两边的历史会分叉/);
  assert.equal(warning[2], '改用新目录', '不是模态：不阻塞使用');
  assert.deepEqual(plain(dismiss.globalState.get('limcode.dataRootMovedNoticeDismissed')), ['r-other']);
  await dismiss.commands.afterDataRootOpened(dismiss.context, SOURCE, dismiss.startup);
  await new Promise(setImmediate);
  assert.equal(dismiss.calls.filter((call) => call[0] === 'warning').length, 1, '不再提醒');

  const follow = fixture({ movedNotice: notice, nativeAnswers: ['改用新目录', '改用并重载'] });
  await follow.commands.afterDataRootOpened(follow.context, SOURCE, follow.startup);
  // The switch coordinates for real (files and locks): give it real time.
  for (let turn = 0; turn < 500 && !follow.kinds().includes('command'); turn += 1) await new Promise((resolve) => setTimeout(resolve, 10));
  assert.equal(follow.calls.find((call) => call[0] === 'exclusive')[1].participantConfirmation, 'final-countdown');
  assert.equal(follow.calls.find((call) => call[0] === 'exclusive')[1].windowState, follow.context.workspaceState);
  const switched = follow.calls.find((call) => call[0] === 'status')[1];
  assert.deepEqual([switched.dataRootPath, switched.lastMigration.fromPath, switched.lastMigration.relocationId], ['/data/moved-by-other', SOURCE, undefined]);
  assert.deepEqual(follow.calls.at(-1).slice(0, 2), ['command', 'workbench.action.reloadWindow']);

  const own = fixture({ movedNotice: { ...notice, installation: { id: '/vscode/global-storage', label: 'here' } } });
  await own.commands.afterDataRootOpened(own.context, SOURCE, own.startup);
  assert.deepEqual(own.calls.find((call) => call[0] === 'clear-moved').slice(1), [SOURCE, '/vscode/global-storage']);
  assert.ok(!own.kinds().includes('warning'), '本安装回到这里：标记直接清掉，不提示');
});

test('盲审 1 切换指针之后的失败不撤销已生效的迁移：先重读指针，指明本次迁移就按已完成处理并如实提示；读不出指针时什么都不撤销；指针没变才撤销（带着证明）', async () => {
  const tookEffect = fixture({ answers: [{ choice: 'relocate', include: [] }], afterLocksError: new Error('EIO: i/o error, rename') });
  await tookEffect.commands.relocateDataRoot(tookEffect.context, tookEffect.startup, tookEffect.request);
  assert.ok(!tookEffect.kinds().includes('abandon'), '已生效的迁移不撤销');
  const done = tookEffect.calls.find((call) => call[0] === 'error');
  assert.equal(done[1], '数据目录迁移已完成');
  assert.match(done[2].detail, /迁移已完成，收尾时出错：.*EIO: i\/o error, rename/);
  assert.equal(tookEffect.status.dataRootPath, TARGET);
  assert.equal(tookEffect.status.pendingRelocation, undefined);
  assert.deepEqual(tookEffect.calls.at(-1).slice(0, 2), ['command', 'workbench.action.reloadWindow']);

  const unknown = fixture({ answers: [{ choice: 'relocate', include: [] }], completeError: new Error('写指针失败'), cleanup: 'not-cleaned', statusUnreadable: true });
  await unknown.commands.relocateDataRoot(unknown.context, unknown.startup, unknown.request);
  assert.ok(!unknown.kinds().includes('abandon'), '读不出指针：无法证明没切换，不撤销');
  const told = unknown.calls.find((call) => call[0] === 'error');
  assert.equal(told[1], '无法确认数据目录迁移的结果');
  assert.ok(unknown.status.pendingRelocation, '进行中记录保留，下次启动再判断');

  const unchanged = fixture({ answers: [{ choice: 'relocate', include: [] }], completeError: new Error('写指针失败'), cleanup: 'not-cleaned' });
  await unchanged.commands.relocateDataRoot(unchanged.context, unchanged.startup, unchanged.request);
  assert.deepEqual(unchanged.abandonOptions, [{ pointerUnchanged: true }], '重读指针确认没切换，才带着证明撤销');
  assert.match(unchanged.calls.find((call) => call[0] === 'error')[2].detail, /数据目录没有切换/);
});

test('盲审 7 启动时进行中记录的目标一直看不到：提示并给出“放弃这次迁移的记录”（二次确认），确认后清除记录；不确认就保留', async () => {
  const pending = {
    relocationId: 'lost', sourceRootPath: SOURCE, targetRootPath: '/mnt/lost/limcode', startedAt: '2026-09-27T00:00:00.000Z', processId: 1,
    targetAnchor: { parent: '1:1' }
  };
  const forget = fixture({ pendingRelocation: pending, recoverOutcome: 'unreachable', nativeAnswers: ['放弃这次迁移的记录…', '放弃这次迁移的记录'] });
  await forget.commands.beforeDataRootOpen(forget.context);
  assert.deepEqual(forget.calls.find((call) => call[0] === 'recover')[1].anchor, { parent: '1:1' }, '续撤带着目标锚点');
  const warning = forget.calls.find((call) => call[0] === 'warning');
  assert.match(warning[1], /现在看不到/);
  assert.equal(warning[2], '放弃这次迁移的记录…', '原生提示里只多一个选项');
  assert.equal(forget.status.pendingRelocation, undefined, '确认后清除进行中记录');
  const keep = fixture({ pendingRelocation: pending, recoverOutcome: 'unreachable', nativeAnswers: [undefined] });
  await keep.commands.beforeDataRootOpen(keep.context);
  assert.ok(keep.status.pendingRelocation, '不确认就保留，下次再试');
});

const carriedNotice = (overrides = {}) => ({
  targetRootPath: '/mnt/new/limcode', relocationId: 'r-7', movedAt: '2026-09-27T08:30:00.000Z',
  installation: { id: '/vscode/global-storage', label: 'VS Code（本机）' },
  carriedWork: { dataSets: [{
    id: 'default', dataSetId: 'current', settlement: { state: 'pending' },
    inventory: { conversations: [{
      conversationId: 'conversation-1', title: '部署脚本', otherRuntimeWork: false,
      activeTurnIds: ['turn-1'], queuedIntentIds: [], unfinishedModelRequestIds: [], pendingInteractionIds: [], childExecutionIds: [],
      pendingDeliveryIds: ['delivery-1'], pendingProcessCompletionIds: ['dispatch-1'], undeliveredAnswerIds: [], unreceiptedEffectIds: []
    }] }
  }] },
  ...overrides
});

test('补充 E 打开带着迁走任务的旧目录（moved-work）：三选一；如实说明全部收尾之前不执行、收尾不了就不打开（不再说“不再执行”或“打开后仍会执行一次”）；在这里继续先记下同意再重载，改用新目录只切指针，暂不打开什么都不做', async () => {
  const offer = async (choice, nativeAnswers = []) => {
    const f = fixture({ host: false, recoveryChoice: choice, movedNotice: carriedNotice(), nativeAnswers });
    await f.commands.offerDataRootRecovery(f.context, f.startup, '数据目录暂时没有打开', 'moved-work');
    return f;
  };
  const here = await offer('在这里继续（已迁走的任务按中止收尾）');
  const prompt = here.calls.find((call) => call[0] === 'error');
  assert.deepEqual(prompt.slice(3), ['在这里继续（已迁走的任务按中止收尾）', '改用新目录', '暂不打开']);
  assert.match(prompt[2].detail, /由 VS Code（本机） 迁移到 \/mnt\/new\/limcode/);
  assert.match(prompt[2].detail, /1 个对话还有没完成的任务（“部署脚本”）/);
  assert.match(prompt[2].detail, /在这里继续使用时，打开时先把它们全部按中止收尾，收尾完之前这里不执行任何工作；有收尾不了的（例如另一个窗口正占着它，或需要人工处理），这次就不打开，并逐条说明是哪一项、为什么、该怎么做。/);
  assert.doesNotMatch(prompt[2].detail, /不再执行|打开后仍会执行一次|收尾不了，打开后/, '不再有“只报告再放行”的说法');
  assert.doesNotMatch(prompt[2].detail, /会开启新的回合|还没送达的子 Agent 答复|已结束进程的完成通知/, '上一轮的旧类别文案已删掉');
  assert.deepEqual(here.calls.find((call) => call[0] === 'consent'), ['consent', SOURCE, 'r-7', '/vscode/global-storage']);
  assert.ok(here.kinds().indexOf('consent') < here.kinds().lastIndexOf('command'));
  assert.deepEqual(here.calls.at(-1).slice(0, 2), ['command', 'workbench.action.reloadWindow']);

  const elsewhere = await offer('改用新目录', ['改用并重载']);
  assert.ok(!elsewhere.kinds().includes('consent'), '改用新目录：这里什么都不收尾');
  assert.equal(elsewhere.calls.find((call) => call[0] === 'status')[1].dataRootPath, '/mnt/new/limcode');

  const later = await offer('暂不打开');
  assert.ok(!later.kinds().includes('consent') && !later.kinds().includes('status') && !later.kinds().includes('command'), '暂不打开：什么都不做');
});

test('最后一轮 #4 这个目录里那次没成功的迁移正在撤销（relocation-undoing）：只给“重试”，说明撤销完成之后就能打开', async () => {
  const message = '数据目录暂时不能打开：里面有一次没有成功的数据迁移，发起它的 LimCode 窗口正在撤销它在这里的改动';
  const f = fixture({ host: false, recoveryChoice: '重试' });
  await f.commands.offerDataRootRecovery(f.context, f.startup, message, 'relocation-undoing');
  assert.deepEqual(f.calls.find((call) => call[0] === 'error').slice(1), [`${message}\n\n撤销完成之后就能打开，请稍后重试。`, '重试']);
  assert.deepEqual(f.calls.at(-1).slice(0, 2), ['command', 'workbench.action.reloadWindow']);
});

test('最后一轮 #1 这次打开留下了没收尾的项（moved-work-unsettled）：模态提示逐条写明是什么、在哪个对话、为什么没收尾、该怎么做，并说明全部收尾前这里不执行任何工作', async () => {
  const items = [
    { conversationId: 'conversation-1', title: '部署脚本', list: 'activeTurnIds', id: 'turn-1', why: 'live', detail: '' },
    { conversationId: 'conversation-1', title: '部署脚本', list: 'undeliveredAnswerIds', id: 'answer-1', why: 'live', detail: '' },
    { conversationId: 'conversation-2', title: '周报', list: 'activeTurnIds', id: 'turn-2', why: 'needs_human', detail: 'Turn 的终态事实不一致，需要人工处理；已记录停止请求。' },
    { conversationId: 'conversation-3', title: '', list: 'pendingDeliveryIds', id: 'delivery-9', why: 'rounds_exhausted', detail: '收尾 5 轮后仍出现新的可执行项（pendingDeliveryIds），这次不再收尾。' },
    { conversationId: '', title: '', list: 'round', id: 'round-2', why: 'failed', detail: '第 2 轮之前协作收敛或重新盘点失败（试了 3 次）：revision conflict' },
    { conversationId: '', title: '', list: 'round', id: 'settlement', why: 'failed', detail: '收尾中途出错：数据库 worker 已退出' }
  ];
  const f = fixture({ host: false, recoveryChoice: undefined, movedNotice: carriedNotice() });
  const error = Object.assign(new Error('数据目录这次没有打开'), { reason: 'moved-work-unsettled', cause: { items } });
  await f.commands.offerDataRootRecovery(f.context, f.startup, '数据目录这次没有打开：迁走的任务还没有全部收尾（还剩 5 项）', 'moved-work-unsettled', error);
  const prompt = f.calls.find((call) => call[0] === 'error');
  assert.equal(prompt[1], '数据目录这次没有打开：迁走的任务还没有全部收尾（还剩 5 项）');
  assert.equal(prompt[2].modal, true, '模态：逐条列出');
  assert.deepEqual(prompt.slice(3), ['重试', '改用新目录']);
  const lines = prompt[2].detail.split('\n');
  assert.deepEqual(lines, [
    '还没收尾的项：',
    '· 对话“部署脚本”里的进行中的回合（turn-1）：另一个 LimCode 窗口正在执行或占着它，这里收尾不了。关闭或重载那个窗口（或等它结束）之后重试。',
    '· 对话“部署脚本”里的子 Agent 的答复（answer-1）：另一个 LimCode 窗口正在执行或占着它，这里收尾不了。关闭或重载那个窗口（或等它结束）之后重试。',
    '· 对话“周报”里的进行中的回合（turn-2）：停止流程收不掉它（Turn 的终态事实不一致，需要人工处理；已记录停止请求。）。可以稍后重试（它可能自己结束），或改用新目录，在那里处理这个对话。',
    '· 对话“conversation-3”里的待投递的结果或消息（delivery-9）：收尾几轮之后仍不断出现新的工作（收尾 5 轮后仍出现新的可执行项（pendingDeliveryIds），这次不再收尾。）。重试时会接着收尾；一直这样时可以改用新目录。',
    '· 第 2 轮收尾：收尾时出错（第 2 轮之前协作收敛或重新盘点失败（试了 3 次）：revision conflict）。可以重试；一直出错时可以改用新目录。',
    '· 收尾过程：收尾时出错（收尾中途出错：数据库 worker 已退出）。可以重试；一直出错时可以改用新目录。',
    '在全部收尾之前，这个目录不会在这里打开，里面的任何工作都不会执行；重试时会先把迁走的任务整库再收尾一次。'
  ]);
  assert.ok(!f.kinds().includes('command') && !f.kinds().includes('status') && !f.kinds().includes('consent'), '关掉提示：什么都不做');
});

test('最后一轮 #6 moved-work-unsettled 的出路：重试（重载）、改用新目录（只切指针）；错误里没带条目时列出标记里最近一次记下的；打开之后不再有剩余项提示（有剩余项就不会打开）', async () => {
  const leftAt = (at, id) => ({ at, by: '/vscode/global-storage', items: [{ conversationId: 'conversation-1', title: '部署脚本', list: 'activeTurnIds', id, why: 'live', detail: '' }] });
  const notice = carriedNotice({ carriedWork: { dataSets: [
    { ...carriedNotice().carriedWork.dataSets[0], settlement: { state: 'consented', at: '2026-09-27T09:00:00.000Z', by: '/vscode/global-storage', left: leftAt('2026-09-27T10:00:00.000Z', 'turn-old') } },
    { ...carriedNotice().carriedWork.dataSets[0], id: 'workspace:abc', settlement: { state: 'consented', at: '2026-09-27T09:00:00.000Z', by: '/vscode/global-storage', left: leftAt('2026-09-27T11:00:00.000Z', 'turn-new') } }
  ] } });
  const offer = async (choice, nativeAnswers = []) => {
    const f = fixture({ host: false, recoveryChoice: choice, movedNotice: notice, nativeAnswers });
    await f.commands.offerDataRootRecovery(f.context, f.startup, '数据目录这次没有打开', 'moved-work-unsettled');
    return f;
  };
  const retry = await offer('重试');
  const prompt = retry.calls.find((call) => call[0] === 'error');
  assert.match(prompt[2].detail, /turn-new/);
  assert.doesNotMatch(prompt[2].detail, /turn-old/, '只列最近一次打开留下的');
  assert.deepEqual(retry.calls.at(-1).slice(0, 2), ['command', 'workbench.action.reloadWindow']);
  assert.ok(!retry.kinds().includes('consent'), '已经同意过：不再询问');
  const elsewhere = await offer('改用新目录', ['改用并重载']);
  assert.equal(elsewhere.calls.find((call) => call[0] === 'status')[1].dataRootPath, '/mnt/new/limcode');
  const nothing = await offer(undefined);
  assert.ok(!nothing.kinds().includes('command') && !nothing.kinds().includes('status'));

  const opened = fixture({ movedNotice: carriedNotice({ carriedWork: { dataSets: [{ ...carriedNotice().carriedWork.dataSets[0], settlement: {
    state: 'settled', at: '2026-09-27T12:00:00.000Z', by: '/vscode/global-storage', result: { counts: { turnsStopped: 1 } }
  } }] } }) });
  await opened.commands.afterDataRootOpened(opened.context, SOURCE, opened.startup);
  assert.deepEqual(opened.calls.filter((call) => call[0] === 'warning'), [], '打开之后没有剩余项提示');
});

test('最后一轮 决定三 “已迁走”标记读不懂（moved-notice-invalid）：按不能访问一类给出路（重试、改用标记里写的新目录、回到旧目录、选择其它目录、使用默认目录）；读不出新目录时不给“改用迁移后的目录”', async () => {
  const message = '数据目录这次没有打开：“数据已迁走”标记读不懂';
  const readable = fixture({ host: false, recoveryChoice: '改用迁移后的目录', nativeAnswers: ['改用并重载'],
    movedRead: { invalid: '迁走的任务清单或它的收尾状态不是本版本认得的内容', targetRootPath: '/mnt/new/limcode' } });
  await readable.commands.offerDataRootRecovery(readable.context, readable.startup, message, 'moved-notice-invalid');
  const prompt = readable.calls.find((call) => call[0] === 'error');
  assert.equal(prompt[1], `${message}\n\n标记里写的新目录：/mnt/new/limcode。`);
  assert.deepEqual(prompt.slice(2), ['重试', '改用迁移后的目录', '选择其它目录…', '使用默认目录…']);
  assert.equal(readable.calls.find((call) => call[0] === 'status')[1].dataRootPath, '/mnt/new/limcode', '只切指针');
  assert.ok(!readable.kinds().includes('consent'));
  const broken = fixture({ host: false, recoveryChoice: '重试', movedRead: { invalid: '不是完整的 JSON' } });
  await broken.commands.offerDataRootRecovery(broken.context, broken.startup, message, 'moved-notice-invalid');
  assert.deepEqual(broken.calls.find((call) => call[0] === 'error').slice(1), [message, '重试', '选择其它目录…', '使用默认目录…']);
  assert.deepEqual(broken.calls.at(-1).slice(0, 2), ['command', 'workbench.action.reloadWindow']);
});

test('补充 E 发起安装“回到旧目录”：确认那一步就算同意，旧目录里带走的任务在打开时直接收尾；提示里写明；别的安装后来的标记不算（由它管着旧目录的打开）', async () => {
  const lastMigration = { fromPath: '/data/older', toPath: SOURCE, migratedAt: '2026-09-26T00:00:00.000Z', relocationId: 'r-7' };
  const own = fixture({ lastMigration, answers: [{ choice: 'return', include: [] }], movedNotice: carriedNotice({ targetRootPath: SOURCE }) });
  await own.commands.returnToPreviousDataRoot(own.context, own.startup, own.request);
  assert.match(JSON.stringify(own.prompts[0]), /在这里继续使用时，打开时先把它们全部按中止收尾，收尾完之前这里不执行任何工作/);
  assert.deepEqual(own.calls.find((call) => call[0] === 'consent'), ['consent', '/data/older', 'r-7', '/vscode/global-storage']);
  assert.ok(own.kinds().indexOf('consent') < own.kinds().indexOf('status'), '先记下同意，再切换指针');
  const other = fixture({ lastMigration, answers: [{ choice: 'return', include: [] }],
    movedNotice: carriedNotice({ targetRootPath: SOURCE, relocationId: 'r-later', installation: { id: '/other/installation', label: '另一个安装' } }) });
  await other.commands.returnToPreviousDataRoot(other.context, other.startup, other.request);
  assert.ok(!other.kinds().includes('consent'), '别的安装的标记不替它同意');
  assert.equal(other.calls.find((call) => call[0] === 'status')?.[1].dataRootPath, '/data/older', '照常切换：旧目录的打开由那份标记管着');
  const declined = fixture({ lastMigration, answers: [{ choice: 'cancel', include: [] }], movedNotice: carriedNotice({ targetRootPath: SOURCE }) });
  await declined.commands.returnToPreviousDataRoot(declined.context, declined.startup, declined.request);
  assert.ok(!declined.kinds().includes('consent'), '没确认就不算同意');
});

test('最后一轮 决定二 “回到旧目录”找不到这次迁移的标记（或读不出、读不懂、只有本安装别的迁移的标记）时如实报错、不切换；记同意失败时也报错、不切换', async () => {
  const lastMigration = { fromPath: '/data/older', toPath: SOURCE, migratedAt: '2026-09-26T00:00:00.000Z', relocationId: 'r-7' };
  const cases = [
    ['missing', { movedRead: { none: true } }, /旧目录里找不到这次迁移留下的“数据已迁走”标记（\/data\/older\/\.limcode-data-root-moved\.json）/],
    ['unreadable', { movedRead: Object.assign(new Error('EACCES: permission denied'), { code: 'EACCES' }) }, /读不出旧目录里的“数据已迁走”标记（\/data\/older\/\.limcode-data-root-moved\.json：(Error: )?EACCES: permission denied）/],
    ['invalid', { movedRead: { invalid: '不是完整的 JSON', targetRootPath: SOURCE } }, /旧目录里的“数据已迁走”标记读不懂（\/data\/older\/\.limcode-data-root-moved\.json：不是完整的 JSON）/],
    ['own-other', { movedNotice: carriedNotice({ targetRootPath: SOURCE, relocationId: 'r-older' }) }, /旧目录里找不到这次迁移留下的“数据已迁走”标记/]
  ];
  for (const [name, options, expected] of cases) {
    const f = fixture({ lastMigration, answers: [{ choice: 'return', include: [] }], ...options });
    await f.commands.returnToPreviousDataRoot(f.context, f.startup, f.request);
    assert.equal(f.prompts[0]?.title, '现在不能回到旧目录', name);
    assert.match(JSON.stringify(f.prompts[0]), expected, name);
    assert.match(JSON.stringify(f.prompts[0]), /无法确认迁走的任务在旧目录里不会再执行一次|无法确认迁走的任务在那里不会再执行一次/, name);
    assert.ok(!f.kinds().includes('consent') && !f.kinds().includes('status'), `${name}：不同意、不切换`);
  }
  const failing = fixture({ lastMigration, answers: [{ choice: 'return', include: [] }], movedNotice: carriedNotice({ targetRootPath: SOURCE }),
    consentError: Object.assign(new Error('EIO: i/o error, write'), { code: 'EIO' }) });
  await failing.commands.returnToPreviousDataRoot(failing.context, failing.startup, failing.request);
  assert.deepEqual(failing.prompts.map((prompt) => prompt.title), ['回到迁移前的旧数据目录？', '没有回到旧目录']);
  assert.match(JSON.stringify(failing.prompts[1]), /没能在旧目录里记下“迁走的任务按中止收尾”（(Error: )?EIO: i\/o error, write），所以没有切换/);
  assert.ok(!failing.kinds().includes('status'), '同意没记下：不切换');
  const without = fixture({ lastMigration: { ...lastMigration, relocationId: undefined }, answers: [{ choice: 'return', include: [] }] });
  await without.commands.returnToPreviousDataRoot(without.context, without.startup, without.request);
  assert.ok(!without.kinds().includes('inspect-moved'), '只切过指针的记录（没有迁移 id）：没有要找的标记');
  assert.equal(without.calls.find((call) => call[0] === 'status')?.[1].dataRootPath, '/data/older');
});
