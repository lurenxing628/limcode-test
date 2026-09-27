const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const os = require('node:os');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const test = require('node:test');
const ts = require('typescript');

/** Loads vscode/commands/dataRootRelocation.ts with every dependency replaced by a recording fake. */
function loadCommands(dependencies) {
  const filename = path.resolve(__dirname, '../../vscode/commands/dataRootRelocation.ts');
  const module = { exports: {} };
  vm.runInNewContext(ts.transpileModule(fs.readFileSync(filename, 'utf8'), {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS }
  }).outputText, {
    module, exports: module.exports, console, process, AbortController,
    require(name) {
      if (name === 'node:crypto') return crypto;
      if (name === 'node:os') return os;
      if (!Object.prototype.hasOwnProperty.call(dependencies, name)) throw new Error(`Unexpected source dependency: ${name}`);
      return dependencies[name];
    }
  }, { filename });
  return module.exports;
}

const SOURCE = '/data/old-home';
const TARGET = '/data/new-home';
const plain = (value) => JSON.parse(JSON.stringify(value));

function fixture({
  picked = TARGET, plan = {}, answers = [], busy = [false], exclusive = 'completed', completeError, cleanup,
  closeError, abandonError, lastMigration, pendingRelocation, ownerState = 'dead', returnUsable = true, currentAvailable = true,
  host = true, deletion = {}, deleteResult = { removed: ['data-set:default'], remainingDataSets: 0 }, recoveryChoice,
  nativeAnswers = [], recoverOutcome = 'recovered', cancelStage = false, movedNotice, copyAside, hold,
  afterLocksError, statusUnreadable = false, undoUnpublishedResult = {}
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
  const application = host ? {
    product: { application: { database } },
    async hasOwnedExecution() {
      const value = busy.length > 1 ? busy.shift() : busy[0];
      calls.push(['busy?', value instanceof Error ? 'error' : value]);
      if (value instanceof Error) throw value;
      return value;
    },
    exclusiveMaintenanceTarget() { return { paths: { dataRootPath: `${SOURCE}/.limcode-runtime/active` }, hostBootId: 'host-1' }; },
    dataRootPath() { return SOURCE; },
    async withDataRootLocks(body) { calls.push(['locks']); return body(); },
    async closeRuntime() { calls.push(['close-runtime']); if (closeError) throw closeError; },
    freezeNewWork() { calls.push(['freeze']); return () => calls.push(['thaw']); },
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
      readDataRootMovedNotice: async (root) => { calls.push(['read-moved', root]); return movedNotice; },
      clearDataRootMovedNotice: async (root, installation) => { calls.push(['clear-moved', root, installation]); return false; },
      sweepDataRootRelocationLeftovers: async (root) => { calls.push(['sweep', root]); return { removed: [] }; },
      findDataRootRelocationCopy: async (root, relocationId) => { calls.push(['find-copy', root, relocationId]); return copyAside; },
      readDataRootRelocationHold: async (root) => { calls.push(['read-hold', root]); return hold; },
      isDataRootRelocationTargetInvisible: (error) => error?.code === 'data-root-relocation-target-invisible',
      undoUnpublishedDataRootRelocation: async (root) => { calls.push(['undo-unpublished', root]); return undoUnpublishedResult; }
    },
    '../../backend/reliableKernel/runtimeExclusiveMaintenance': {
      clearExclusiveMaintenanceKey: async (_paths, operation, operationKey) => { calls.push(['clear-key', operation, operationKey]); }
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
    '../runtimeExclusiveMaintenance': {
      requesterWorkBusy: (target) => async () => ((await target.hasOwnedExecution()) ? { kind: 'work', reason: '本窗口有任务正在进行' } : undefined),
      runWithExclusiveMaintenance: async (paths, options, operation) => {
        calls.push(['exclusive', options]);
        if (exclusive !== 'completed') return { state: exclusive, hosts: [], reason: '另一个窗口有任务正在进行' };
        // Like the primitive: beforeGo once everything is ready, the operation under the locks, then the thaw.
        const result = await options.withLocks(async () => {
          const check = await options.beforeGo();
          try {
            if (check.busy) return { busy: check.busy };
            return { value: await operation({ reportStage: (text) => calls.push(['report-stage', text]) }) };
          } finally { await check.thaw?.(); }
        });
        // E.g. releasing the old directory's claim fails after the operation succeeded.
        if (afterLocksError) throw afterLocksError;
        if (result.busy) return { state: 'busy', hosts: [], reason: result.busy.reason };
        return { state: 'completed', result: result.value, coordinated: true };
      }
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
  return { calls, abandonOptions, prompts, commands, context, startup, status, request, globalState, progressOptions, cancellation, kinds: () => calls.map((call) => call[0]).filter((kind) => kind !== 'progress') };
}

const modal = (call) => call[2]?.modal === true || call.slice(2).some((item) => item?.modal === true);

test('迁移成功：确认在设置页 ConfirmPanel 里；先记下迁移进行中并在线准备，锁外等待后倒计时不可否决地重载其它窗口，再查一次本窗口的任务，关闭运行时，最后切换指针', async () => {
  const f = fixture({ answers: [{ choice: 'relocate', include: [] }] });
  await f.commands.relocateDataRoot(f.context, f.startup, f.request);
  assert.deepEqual(f.kinds(), [
    'open-dialog', 'plan', 'busy?', 'prompt', 'status', 'stage', 'exclusive', 'locks', 'busy?', 'freeze', 'busy?', 'busy?', 'report-stage', 'close-runtime',
    'complete', 'report-stage', 'status', 'thaw', 'clear-key', 'global-state', 'command'
  ]);
  // reloc3 #6: only the preparation can be cancelled; the coordinated part has no cancel button.
  assert.deepEqual(plain(f.progressOptions).filter(({ title }) => title.startsWith('正在迁移数据目录')).map(({ title, cancellable }) => [title, cancellable]),
    [['正在迁移数据目录：准备中（可以取消）', true], ['正在迁移数据目录（已不能取消）', false]]);
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

test('发起窗口在等待期间开始新任务：只提示一次迁移会推迟；确认之后（beforeGo）仍有任务就退回，撤销准备，不重载；忙时不冻结', async () => {
  const f = fixture({ answers: [{ choice: 'relocate', include: [] }], busy: [false, true, true, true] });
  await f.commands.relocateDataRoot(f.context, f.startup, f.request);
  const exclusive = f.calls.find((call) => call[0] === 'exclusive')[1];
  assert.deepEqual(plain(await exclusive.requesterBusy()), { kind: 'work', reason: '本窗口有任务正在进行' });
  await exclusive.requesterBusy();
  assert.equal(f.calls.filter((call) => call[0] === 'info' && /会等它结束后再进行/.test(call[1])).length, 1);
  assert.ok(!f.kinds().includes('close-runtime') && !f.kinds().includes('complete'), '忙着的窗口没有被切断');
  assert.deepEqual(f.calls.find((call) => call[0] === 'abandon'), ['abandon', true]);
  assert.equal(f.calls.filter((call) => call[0] === 'status').at(-1)[1].pendingRelocation, null);
  assert.match(JSON.stringify(f.prompts.at(-1)), /本窗口在确认之后开始了新的任务/);
  assert.deepEqual(f.kinds().filter((kind) => kind === 'freeze' || kind === 'thaw'), [], '冻结之前就发现忙：不冻结');
  assert.ok(!f.calls.some((call) => call[0] === 'command'));
});

test('beforeGo 冻结之后的复查：发现检查与冻结之间开始的任务，或复查本身出错（按忙处理），都把解冻交给原语，窗口不会一直冻结', async () => {
  for (const [late, reason] of [[true, /本窗口在确认之后开始了新的任务/], [new Error('探测失败'), /无法确认本窗口是否空闲/]]) {
    const f = fixture({ answers: [{ choice: 'relocate', include: [] }], busy: [false, false, late] });
    await f.commands.relocateDataRoot(f.context, f.startup, f.request);
    assert.deepEqual(f.kinds().filter((kind) => ['busy?', 'freeze', 'thaw'].includes(kind)), ['busy?', 'busy?', 'freeze', 'busy?', 'thaw']);
    assert.ok(!f.kinds().includes('close-runtime'));
    assert.deepEqual(f.calls.find((call) => call[0] === 'abandon'), ['abandon', true]);
    assert.match(JSON.stringify(f.prompts.at(-1)), reason);
    assert.ok(!f.calls.some((call) => call[0] === 'command'));
  }
});

test('其它窗口没有让出：撤销准备、清除进行中记录，本窗口继续使用原目录且不重载，原因显示在设置页', async () => {
  const f = fixture({ answers: [{ choice: 'relocate', include: [] }], exclusive: 'busy' });
  await f.commands.relocateDataRoot(f.context, f.startup, f.request);
  assert.deepEqual(f.calls.find((call) => call[0] === 'abandon'), ['abandon', true]);
  assert.ok(!f.kinds().includes('close-runtime'));
  assert.equal(f.calls.filter((call) => call[0] === 'status').at(-1)[1].pendingRelocation, null);
  assert.match(JSON.stringify(f.prompts.at(-1)), /另一个窗口有任务正在进行/);
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
  for (let turn = 0; turn < 20 && !follow.kinds().includes('command'); turn += 1) await new Promise(setImmediate);
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
