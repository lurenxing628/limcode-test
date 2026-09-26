const assert = require('node:assert/strict');
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
    module, exports: module.exports, console,
    require(name) {
      if (name === 'node:path') return path;
      if (!Object.prototype.hasOwnProperty.call(dependencies, name)) throw new Error(`Unexpected source dependency: ${name}`);
      return dependencies[name];
    }
  }, { filename });
  return module.exports;
}

const SOURCE = '/data/old-home';
const TARGET = '/data/new-home';

function fixture({
  picked = TARGET, plan = {}, confirmations = [], hostBusy = false, exclusive = 'completed', completeError,
  lastMigration, returnUsable = true, currentAvailable = true, host = true, deletion = {}, recoveryChoice
} = {}) {
  const calls = [];
  const status = {
    dataRootPath: SOURCE, proxy: 'http://proxy', proxyShellAndMcp: true,
    ...(lastMigration ? { lastMigration } : {})
  };
  const planFor = (targetRootPath) => ({
    sourceRootPath: SOURCE, targetRootPath,
    target: { kind: 'empty', unrelatedEntries: 0, hasConfiguration: false },
    current: { id: 'default', dataSetId: 'current', rootInstanceId: 'instance', bytes: 4096, casBytes: 1024 },
    others: [], configurationBytes: 100, requiredBytes: 4196, freeBytes: 10_000_000, sameDevice: true,
    problems: [], warnings: [], ...(typeof plan === 'function' ? plan(targetRootPath) : plan)
  });
  const vscode = {
    window: {
      async showOpenDialog(options) { calls.push(['open-dialog', options]); return picked ? [{ fsPath: picked }] : undefined; },
      async showWarningMessage(message, options, ...items) { calls.push(['warning', message, options, items]); return confirmations.shift(); },
      async showInformationMessage(message, options) { calls.push(['info', message, options]); },
      async showErrorMessage(message, ...rest) { calls.push(['error', message, ...rest]); return recoveryChoice; },
      async withProgress(_options, action) { return action({ report: (value) => calls.push(['progress', value.message]) }); }
    },
    ProgressLocation: { Notification: 15 },
    commands: { async executeCommand(command) { calls.push(['command', command]); } }
  };
  const staged = { plan: planFor(TARGET), relocationId: 'relocation-1' };
  const database = { hostBootId: 'host-1' };
  const application = host ? {
    product: { application: { database } },
    async hasOwnedExecution() { return hostBusy; },
    async runWithDataRootOffline(coordinate, operation) {
      let runtimeClosed = false;
      try {
        const outcome = await coordinate({ dataRootPath: `${SOURCE}/.limcode-runtime/active` }, 'host-1', async () => {
          runtimeClosed = true;
          calls.push(['dispose']);
          return operation();
        });
        return { outcome, runtimeClosed };
      } catch (error) {
        return { outcome: { state: 'failed', error }, runtimeClosed };
      }
    }
  } : undefined;
  const startup = {
    wait: async () => { if (!application) throw new Error('no runtime'); return application; },
    pending: () => (application ? Promise.resolve(application) : undefined),
    current: () => application
  };
  const dependencies = {
    vscode,
    '../../backend/capabilities/vscodeStorage/globalStatus': {
      LIMCODE_GLOBAL_STATUS_FILE: '.limcode-global-status.json',
      loadCommittedGlobalStatus: async () => status,
      resolveDataRootUri: (_context, dataRootPath) => ({ fsPath: dataRootPath || '/vscode/global-storage' }),
      sameFsPath: (left, right) => path.resolve(left) === path.resolve(right),
      saveGlobalStatus: async (...args) => {
        calls.push(['save-status', args.slice(1)]);
        status.dataRootPath = args[1];
      }
    },
    '../../backend/reliableKernel/runtimeDataRootRelocation': {
      formatBytes: (bytes) => `${bytes} B`,
      planDataRootRelocation: async ({ targetRootPath }) => { calls.push(['plan', targetRootPath]); return planFor(targetRootPath); },
      stageDataRootRelocation: async (planned, sourceDatabase) => {
        calls.push(['stage', planned.targetRootPath, sourceDatabase === database]);
        return staged;
      },
      completeDataRootRelocation: async (input, publish) => {
        assert.equal(input, staged);
        calls.push(['complete']);
        if (completeError) throw completeError;
        await publish();
        return {
          targetRootPath: TARGET,
          merged: { insertedConversations: 3, insertedRows: 40, linkedCasObjects: 2, copiedCasObjects: 0, reusedCasObjects: 1 },
          configuration: { copiedFiles: 5, replacedFiles: 0 },
          others: { migrated: [], leftBehind: [] }
        };
      },
      abandonStagedDataRootRelocation: async (input) => { calls.push(['abandon', input === staged]); },
      inspectDataRootForReturn: async (root) => { calls.push(['inspect-return', root]); return returnUsable ? { usable: true } : { usable: false, message: '没有当前库' }; },
      assertDataRootAvailable: async () => { if (!currentAvailable) throw new Error('unavailable'); },
      planOldDataRootDeletion: async (input) => {
        calls.push(['plan-delete', input]);
        return { entries: ['.limcode-runtime', 'settings'], bytes: 2048, problems: [], unmigrated: [], ...deletion };
      },
      deleteOldDataRoot: async (input) => { calls.push(['delete', input]); return { removed: ['.limcode-runtime', 'settings'] }; }
    },
    '../../backend/reliableKernel/runtimeHostControl': {
      withRuntimeDataRootAdmission: async (root, run) => { calls.push(['admission', root]); return run(); }
    },
    '../../backend/reliableKernel/vscodeRootAuthority': {
      assertConfigurationRootRuntimesOffline: async (root) => { calls.push(['offline', root]); }
    },
    '../runtimeExclusiveMaintenance': {
      runWithExclusiveMaintenance: async (paths, options, operation) => {
        calls.push(['exclusive', options]);
        if (exclusive !== 'completed') return { state: exclusive, hosts: [], reason: '另一个窗口有任务正在进行' };
        return { state: 'completed', result: await operation(), coordinated: true };
      }
    }
  };
  const commands = loadCommands(dependencies);
  const context = { globalStorageUri: { fsPath: '/vscode/global-storage' } };
  return { calls, commands, context, startup, status, kinds: () => calls.map((call) => call[0]) };
}

test('迁移成功：先在线准备，再请其它窗口在任务结束后重载、本窗口关闭运行时，最后切换指针并重载', async () => {
  const f = fixture({ confirmations: ['迁移并重载'] });
  await f.commands.relocateDataRoot(f.context, f.startup);
  const kinds = f.kinds().filter((kind) => kind !== 'progress');
  assert.deepEqual(kinds, ['open-dialog', 'plan', 'warning', 'stage', 'exclusive', 'dispose', 'complete', 'save-status', 'info', 'command']);
  assert.deepEqual(f.calls.find((call) => call[0] === 'stage').slice(1), [TARGET, true], '预复制读取本窗口打开的数据库');
  const exclusive = f.calls.find((call) => call[0] === 'exclusive')[1];
  assert.equal(exclusive.configurationRootPath, SOURCE);
  assert.equal(exclusive.requesterHostBootId, 'host-1');
  assert.equal(exclusive.participantConfirmation, 'notice');
  assert.equal(exclusive.whenBusy, 'wait');
  assert.equal(exclusive.ignoreBackoff, true);
  const [dataRoot, proxy, lastMigration, proxyShellAndMcp] = f.calls.find((call) => call[0] === 'save-status')[1];
  assert.deepEqual([dataRoot, proxy, lastMigration.fromPath, lastMigration.toPath, proxyShellAndMcp], [TARGET, 'http://proxy', SOURCE, TARGET, true]);
  const confirmation = f.calls.find((call) => call[0] === 'warning');
  assert.equal(confirmation[2].modal, true);
  assert.match(confirmation[2].detail, /旧目录原样保留/);
  assert.match(confirmation[2].detail, /所有窗口重载一次/);
  assert.deepEqual(f.calls.at(-1), ['command', 'workbench.action.reloadWindow']);
});

test('其它窗口没有让出：清理新目录里的半成品，本窗口继续使用原目录且不重载', async () => {
  const f = fixture({ confirmations: ['迁移并重载'], exclusive: 'busy' });
  await f.commands.relocateDataRoot(f.context, f.startup);
  assert.deepEqual(f.calls.find((call) => call[0] === 'abandon'), ['abandon', true]);
  assert.ok(!f.kinds().includes('dispose') && !f.kinds().includes('save-status'));
  assert.ok(!f.calls.some((call) => call[0] === 'command'), '运行时没有关闭，不重载');
  assert.match(f.calls.find((call) => call[0] === 'error')[1], /另一个窗口有任务正在进行/);
});

test('本窗口运行时关闭后迁移失败：不切换指针，提示原因后重载回原目录；清理由迁移自身完成', async () => {
  const f = fixture({ confirmations: ['迁移并重载'], completeError: Object.assign(new Error('同一条记录内容不同'), { code: 'runtime-data-set-merge-conflict' }) });
  await f.commands.relocateDataRoot(f.context, f.startup);
  assert.ok(f.kinds().includes('dispose'));
  assert.ok(!f.kinds().includes('save-status'));
  assert.ok(!f.kinds().includes('abandon'));
  const error = f.calls.find((call) => call[0] === 'error');
  assert.equal(error[2].modal, true);
  assert.match(error[2].detail, /同一条记录内容不同/);
  assert.match(error[2].detail, /数据目录没有切换/);
  assert.deepEqual(f.calls.at(-1), ['command', 'workbench.action.reloadWindow']);
});

test('本窗口有任务、预检不通过或取消确认时不开始迁移', async () => {
  const busy = fixture({ hostBusy: true });
  await busy.commands.relocateDataRoot(busy.context, busy.startup);
  assert.ok(!busy.kinds().includes('stage'));
  assert.match(busy.calls.find((call) => call[0] === 'warning')[1], /本窗口有任务正在进行/);

  const refused = fixture({ plan: { problems: ['新数据目录不能放在当前数据目录里面。'] } });
  await refused.commands.relocateDataRoot(refused.context, refused.startup);
  assert.ok(!refused.kinds().includes('stage'));
  assert.match(refused.calls.find((call) => call[0] === 'error')[2].detail, /不能放在当前数据目录里面/);

  const cancelled = fixture({ confirmations: [undefined] });
  await cancelled.commands.relocateDataRoot(cancelled.context, cancelled.startup);
  assert.ok(!cancelled.kinds().includes('stage'));

  const noRuntime = fixture({ host: false });
  await noRuntime.commands.relocateDataRoot(noRuntime.context, noRuntime.startup);
  assert.match(noRuntime.calls.find((call) => call[0] === 'error')[1], /运行时没有打开/);
});

test('所选文件夹里已有其它文件：推荐新建 LimCode 子文件夹并按它重新预检', async () => {
  const f = fixture({
    plan: (target) => (target === TARGET ? { target: { kind: 'empty', unrelatedEntries: 3, hasConfiguration: false } } : {}),
    confirmations: ['新建子文件夹', '迁移并重载']
  });
  await f.commands.relocateDataRoot(f.context, f.startup);
  assert.deepEqual(f.calls.filter((call) => call[0] === 'plan').map((call) => call[1]), [TARGET, path.join(TARGET, 'LimCode')]);
  assert.equal(f.calls.find((call) => call[0] === 'stage')[1], path.join(TARGET, 'LimCode'));
});

test('数据目录不可用：提供重试与回到旧目录；没有运行时时回到旧目录直接切换指针并重载', async () => {
  const lastMigration = { fromPath: SOURCE, toPath: '/mnt/usb/limcode', migratedAt: '2026-09-26T00:00:00.000Z' };
  const retry = fixture({ host: false, lastMigration, recoveryChoice: '重试' });
  retry.status.dataRootPath = '/mnt/usb/limcode';
  await retry.commands.offerDataRootRecovery(retry.context, retry.startup, '数据目录不可用');
  const prompt = retry.calls.find((call) => call[0] === 'error');
  assert.deepEqual(prompt.slice(2), ['重试', '回到旧目录']);
  assert.deepEqual(retry.calls.at(-1), ['command', 'workbench.action.reloadWindow']);

  const back = fixture({ host: false, lastMigration, recoveryChoice: '回到旧目录', confirmations: ['回到旧目录'], currentAvailable: false });
  back.status.dataRootPath = '/mnt/usb/limcode';
  await back.commands.offerDataRootRecovery(back.context, back.startup, '数据目录不可用');
  const saved = back.calls.find((call) => call[0] === 'save-status')[1];
  assert.equal(saved[0], SOURCE);
  assert.deepEqual([saved[2].fromPath, saved[2].toPath], ['/mnt/usb/limcode', SOURCE]);
  assert.ok(!back.kinds().includes('admission'), '当前目录不可达时不在它上面拿锁');
  assert.deepEqual(back.calls.at(-1), ['command', 'workbench.action.reloadWindow']);

  const noPrevious = fixture({ host: false, recoveryChoice: undefined });
  await noPrevious.commands.offerDataRootRecovery(noPrevious.context, noPrevious.startup, '数据目录不可用');
  assert.deepEqual(noPrevious.calls.find((call) => call[0] === 'error').slice(2), ['重试']);
});

test('回到旧目录（运行时正常）：经多窗口独占协调后只切换指针，不复制数据', async () => {
  const lastMigration = { fromPath: '/data/older', toPath: SOURCE, migratedAt: '2026-09-26T00:00:00.000Z' };
  const f = fixture({ lastMigration, confirmations: ['回到旧目录'] });
  await f.commands.returnToPreviousDataRoot(f.context, f.startup);
  assert.match(f.calls.find((call) => call[0] === 'warning')[2].detail, /不复制也不合并/);
  assert.ok(f.kinds().includes('dispose'));
  assert.equal(f.calls.find((call) => call[0] === 'save-status')[1][0], '/data/older');
  assert.ok(!f.kinds().includes('stage') && !f.kinds().includes('complete'));
  assert.deepEqual(f.calls.at(-1), ['command', 'workbench.action.reloadWindow']);
});

test('删除旧目录：列出占用并确认后只删除 LimCode 条目，随后不再显示旧目录；预检拒绝时不删除', async () => {
  const lastMigration = { fromPath: '/vscode/global-storage', toPath: SOURCE, migratedAt: '2026-09-26T00:00:00.000Z' };
  const f = fixture({ lastMigration, confirmations: ['永久删除'] });
  await f.commands.deletePreviousDataRoot(f.context);
  const planned = f.calls.find((call) => call[0] === 'plan-delete')[1];
  // Values created inside the loaded module's context compare structurally only after a copy.
  assert.deepEqual(JSON.parse(JSON.stringify(planned.keepEntries)), ['.limcode-global-status.json'], 'VS Code 默认目录保留数据目录指针文件');
  const confirmation = f.calls.find((call) => call[0] === 'warning');
  assert.match(confirmation[2].detail, /2048 B/);
  assert.match(confirmation[2].detail, /不能撤销/);
  assert.ok(f.kinds().includes('delete'));
  assert.equal(f.calls.find((call) => call[0] === 'save-status')[1][2], null, '删除后清除迁移记录');

  const refused = fixture({ lastMigration, deletion: { problems: ['找不到从这个目录迁移完成的记录'] } });
  await refused.commands.deletePreviousDataRoot(refused.context);
  assert.ok(!refused.kinds().includes('delete'));

  const unmigrated = fixture({ lastMigration, deletion: { unmigrated: ['workspace:x'] }, confirmations: [undefined] });
  await unmigrated.commands.deletePreviousDataRoot(unmigrated.context);
  assert.match(unmigrated.calls.find((call) => call[0] === 'warning')[2].detail, /1 个历史库没有迁移.*workspace:x/s);
  assert.ok(!unmigrated.kinds().includes('delete'));
});
