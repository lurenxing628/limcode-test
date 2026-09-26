const assert = require('node:assert/strict');
const crypto = require('node:crypto');
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
    module, exports: module.exports, console, process,
    require(name) {
      if (name === 'node:crypto') return crypto;
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
  nativeAnswers = [], recoverOutcome = 'recovered'
} = {}) {
  const calls = [];
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
      async withProgress(_options, action) { return action({ report: (value) => calls.push(['progress', value.message]) }); }
    },
    ProgressLocation: { Notification: 15 },
    commands: { async executeCommand(command, argument) { calls.push(['command', command, argument]); } }
  };
  const staged = { plan: planFor(TARGET), relocationId: 'staged' };
  const database = { hostBootId: 'host-1' };
  const application = host ? {
    product: { application: { database } },
    async hasOwnedExecution() { const value = busy.length > 1 ? busy.shift() : busy[0]; calls.push(['busy?', value]); return value; },
    exclusiveMaintenanceTarget() { return { paths: { dataRootPath: `${SOURCE}/.limcode-runtime/active` }, hostBootId: 'host-1' }; },
    dataRootPath() { return SOURCE; },
    async withDataRootLocks(body) { calls.push(['locks']); return body(); },
    async closeRuntime() { calls.push(['close-runtime']); if (closeError) throw closeError; },
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
      loadCommittedGlobalStatus: async () => status,
      resolveDataRootUri: (_context, dataRootPath) => ({ fsPath: dataRootPath || '/vscode/global-storage' }),
      sameFsPath: (left, right) => path.resolve(left) === path.resolve(right),
      updateGlobalStatusDataRoot: async (_context, change) => {
        calls.push(['status', plain(change)]);
        if (change.dataRootPath !== undefined) status.dataRootPath = change.dataRootPath;
        if (change.pendingRelocation === null) delete status.pendingRelocation;
        else if (change.pendingRelocation) status.pendingRelocation = change.pendingRelocation;
        if (change.lastMigration === null) delete status.lastMigration;
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
      abandonStagedDataRootRelocation: async (input) => {
        calls.push(['abandon', input === staged]);
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
      sweepDataRootRelocationLeftovers: async (root) => { calls.push(['sweep', root]); return { removed: [] }; }
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
        const result = await options.withLocks(operation);
        return { state: 'completed', result, coordinated: true };
      }
    }
  };
  const commands = loadCommands(dependencies);
  const globalState = new Map();
  const context = {
    globalStorageUri: { fsPath: '/vscode/global-storage' },
    globalState: { get: (key) => globalState.get(key), update: async (key, value) => { calls.push(['global-state', key, value]); globalState.set(key, value); } }
  };
  const request = { clientId: 'client-1' };
  return { calls, prompts, commands, context, startup, status, request, globalState, kinds: () => calls.map((call) => call[0]).filter((kind) => kind !== 'progress') };
}

const modal = (call) => call[2]?.modal === true || call.slice(2).some((item) => item?.modal === true);

test('迁移成功：确认在设置页 ConfirmPanel 里；先记下迁移进行中并在线准备，锁外等待后倒计时不可否决地重载其它窗口，再查一次本窗口的任务，关闭运行时，最后切换指针', async () => {
  const f = fixture({ answers: [{ choice: 'relocate', include: [] }] });
  await f.commands.relocateDataRoot(f.context, f.startup, f.request);
  assert.deepEqual(f.kinds(), [
    'open-dialog', 'plan', 'busy?', 'prompt', 'status', 'stage', 'exclusive', 'locks', 'busy?', 'close-runtime', 'complete', 'status',
    'global-state', 'command'
  ]);
  assert.equal(f.calls.find((call) => call[0] === 'plan')[2], true, '行数经本窗口打开的数据库统计');
  const pending = f.calls.find((call) => call[0] === 'status')[1].pendingRelocation;
  assert.deepEqual([pending.sourceRootPath, pending.targetRootPath, pending.processId, pending.processStartIdentity], [SOURCE, TARGET, process.pid, 'start-identity']);
  assert.equal(f.calls.find((call) => call[0] === 'stage')[3], pending.relocationId, '目标里的准备记录与迁移进行记录同一个 id');
  const exclusive = f.calls.find((call) => call[0] === 'exclusive')[1];
  assert.equal(exclusive.participantConfirmation, 'final-countdown');
  assert.equal(exclusive.whenBusy, 'wait');
  assert.equal(exclusive.ignoreBackoff, true);
  assert.equal(exclusive.configurationRootPath, SOURCE);
  assert.equal(exclusive.requesterHostBootId, 'host-1');
  assert.equal(typeof exclusive.withLocks, 'function', '等待在锁外进行，锁只在短轮次里拿');
  assert.equal(typeof exclusive.requesterBusy, 'function', '发起窗口自己的任务也在等待范围内');
  const published = f.calls.filter((call) => call[0] === 'status')[1][1];
  assert.deepEqual([published.dataRootPath, published.dataRootId, published.pendingRelocation, published.lastMigration.fromPath],
    [TARGET, '00000000-0000-4000-8000-000000000001', null, SOURCE]);
  assert.ok(!f.calls.some((call) => (call[0] === 'warning' || call[0] === 'error') && modal(call)), '除了选文件夹，没有原生模态框');
  const confirmation = f.prompts[0];
  assert.deepEqual(confirmation.actions.map((action) => action.key), ['cancel', 'relocate']);
  const text = JSON.stringify(confirmation.sections);
  assert.match(text, /旧目录的数据不会被修改/);
  assert.doesNotMatch(text, /原样保留/);
  assert.match(f.globalState.get('limcode.dataRootRelocationNotice'), /1 个历史库留在旧目录/);
  assert.deepEqual(f.calls.at(-1).slice(0, 2), ['command', 'workbench.action.reloadWindow']);
});

test('发起窗口在等待期间开始新任务：只提示一次迁移会推迟；关闭运行时前最后一刻又有任务就放弃，撤销准备，不重载', async () => {
  const f = fixture({ answers: [{ choice: 'relocate', include: [] }], busy: [false, true, true, true] });
  await f.commands.relocateDataRoot(f.context, f.startup, f.request);
  const exclusive = f.calls.find((call) => call[0] === 'exclusive')[1];
  assert.deepEqual(plain(await exclusive.requesterBusy()), { kind: 'work', reason: '本窗口有任务正在进行' });
  await exclusive.requesterBusy();
  assert.equal(f.calls.filter((call) => call[0] === 'info' && /会等它结束后再进行/.test(call[1])).length, 1);
  assert.ok(!f.kinds().includes('close-runtime') && !f.kinds().includes('complete'), '忙着的窗口没有被切断');
  assert.deepEqual(f.calls.find((call) => call[0] === 'abandon'), ['abandon', true]);
  assert.equal(f.calls.filter((call) => call[0] === 'status').at(-1)[1].pendingRelocation, null);
  assert.match(JSON.stringify(f.prompts.at(-1)), /最后一刻开始了新的任务/);
  assert.ok(!f.calls.some((call) => call[0] === 'command'));
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
  const fallback = fixture({ host: false, recoveryChoice: '使用默认目录…', nativeAnswers: ['改用默认目录并重载'] });
  fallback.status.dataRootPath = '/mnt/usb/limcode';
  await fallback.commands.offerDataRootRecovery(fallback.context, fallback.startup, '数据目录不可用');
  const warning = fallback.calls.find((call) => call[0] === 'warning');
  assert.match(warning[2].detail, /新建一份空的历史/);
  const fallbackStatus = fallback.calls.find((call) => call[0] === 'status')[1];
  assert.deepEqual([fallbackStatus.dataRootPath, fallbackStatus.dataRootId], ['', null]);
  assert.deepEqual(fallback.calls.at(-1).slice(0, 2), ['command', 'workbench.action.reloadWindow']);
});

test('回到旧目录：运行时正常时经独占协调（倒计时不可否决）后让当前目录的迁移记录失效，再只切换指针；当前目录不可达时不在它上面拿锁', async () => {
  const lastMigration = { fromPath: '/data/older', toPath: SOURCE, migratedAt: '2026-09-26T00:00:00.000Z' };
  const f = fixture({ lastMigration, answers: [{ choice: 'return', include: [] }] });
  await f.commands.returnToPreviousDataRoot(f.context, f.startup, f.request);
  assert.match(JSON.stringify(f.prompts[0]), /不复制也不合并/);
  assert.equal(f.calls.find((call) => call[0] === 'exclusive')[1].participantConfirmation, 'final-countdown');
  const order = f.kinds();
  assert.ok(order.indexOf('close-runtime') < order.indexOf('invalidate') && order.indexOf('invalidate') < order.indexOf('status'));
  assert.deepEqual(f.calls.find((call) => call[0] === 'invalidate'), ['invalidate', SOURCE]);
  const status = f.calls.find((call) => call[0] === 'status')[1];
  assert.deepEqual([status.dataRootPath, status.dataRootId, status.lastMigration.fromPath], ['/data/older', '00000000-0000-4000-8000-000000000002', SOURCE]);
  assert.ok(!f.kinds().includes('stage') && !f.kinds().includes('complete'));

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
  assert.deepEqual(opened.kinds(), ['finalize', 'sweep', 'global-state', 'info']);
  await opened.commands.afterDataRootOpened(opened.context, TARGET);
  assert.equal(opened.calls.filter((call) => call[0] === 'info').length, 1, '结果只显示一次');
});
