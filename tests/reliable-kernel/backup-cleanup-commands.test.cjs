const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const test = require('node:test');
const ts = require('typescript');

const compiled = path.resolve(process.env.LIMCODE_TEST_EXTENSION_ROOT ?? 'dist/extension');
const writeGateModule = require(path.join(compiled, 'backend/application/reliableKernel/runtimeWriteGate.js'));
const { RuntimeWriteGate } = writeGateModule;
const hostControl = require(path.join(compiled, 'backend/reliableKernel/runtimeHostControl.js'));
const { formatLocalTime, RuntimeBackupCleanupError } = require(path.join(compiled, 'backend/reliableKernel/runtimeBackupCleanup.js'));

/** Loads vscode/commands/backupCleanup.ts with every dependency replaced by a recording fake. */
function loadCommand(dependencies, sandboxConsole = console) {
  const filename = path.resolve(__dirname, '../../vscode/commands/backupCleanup.ts');
  const module = { exports: {} };
  vm.runInNewContext(ts.transpileModule(fs.readFileSync(filename, 'utf8'), {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS }
  }).outputText, {
    module, exports: module.exports, console: sandboxConsole, process,
    require(name) {
      if (!Object.prototype.hasOwnProperty.call(dependencies, name)) throw new Error(`Unexpected source dependency: ${name}`);
      return dependencies[name];
    }
  }, { filename });
  return module.exports;
}

const ROOT = '/data/limcode';
const extensionContext = { globalStorageUri: { fsPath: '/data/limcode' } };
const CONTROL = `${ROOT}/.limcode-runtime`;
const plain = (value) => JSON.parse(JSON.stringify(value));

function item(overrides) {
  return {
    key: 'merge-target:.limcode-runtime/merge-backups/a', kind: 'merge-target', name: 'a', path: `${CONTROL}/merge-backups/a`,
    dataSetCandidateId: 'default', dataSetName: '当前库', inCurrentDataSet: true, bytes: '2048', reclaimableBytes: '1024', fileCount: 2,
    createdAt: '2026-09-20T01:02:00.000Z', deletable: true, reason: '可以删除：内容已完整在当前库里（其中 2 个对话、4 个消息版本都在，显示的消息相同，正文文件也都在）', ...overrides
  };
}

const PLAN = {
  configurationRootPath: ROOT,
  checkedAt: '2026-09-27T08:00:00.000Z',
  finishedDeletions: [`${CONTROL}/merge-backups/old.deleting-0123456789abcdef`],
  restoredDeletions: [],
  problems: [],
  details: [],
  items: [
    item({ key: 'merge-target:old', name: 'merge-old', path: `${CONTROL}/merge-backups/merge-old` }),
    item({ key: 'merge-target:newest', name: 'merge-newest', path: `${CONTROL}/merge-backups/merge-newest`, deletable: false, reason: '这是这个库最新的一份满 1 小时的完整合并前备份，保留' }),
    item({
      key: 'epoch-migration:up', kind: 'epoch-migration', name: 'upgrade', path: `${CONTROL}/epoch-migration-backups/upgrade`, bytes: '4096', reclaimableBytes: '4096',
      deletable: false, reason: '含 3 个当前库没有的对话（可能是你删掉的），按历史保留', missingConversations: 3
    }),
    item({
      key: 'merge-source:src', kind: 'merge-source', name: 'source', path: '/data/limcode/.limcode-workspace-runtimes/scopes/x/.limcode-runtime/merge-source-backups/source',
      dataSetCandidateId: 'workspace:folder-x', dataSetName: '历史库“项目甲”', inCurrentDataSet: false, bytes: '1048576', reclaimableBytes: '1048576',
      reason: '可以删除：内容已完整在历史库“项目甲”里（其中 1 个对话、2 个消息版本都在，显示的消息相同，正文文件也都在）'
    }),
    item({
      key: 'reset-archive:arch', kind: 'reset-archive', name: 'notes', path: `${ROOT}/.limcode-runtime-backups/notes`,
      dataSetName: undefined, inCurrentDataSet: false, bytes: '100', reclaimableBytes: '100', deletable: false, reason: '归档目录里不是“归档并重置”留下的归档（名字不认识）；只列出，不删除'
    }),
    item({
      key: 'foreign-history:foreign:archive:0123456789abcdef', kind: 'foreign-history', name: '20260901-010203-004-abcdef12',
      path: `${ROOT}/.limcode-runtime-backups/20260901-010203-004-abcdef12`, origin: '“归档并重置”的归档', dataSetCandidateId: undefined,
      dataSetName: undefined, inCurrentDataSet: false, bytes: '4096', reclaimableBytes: '4096', reason: '可以删除：内容已完整在当前库里（其中 2 个对话、4 个消息版本都在，显示的消息相同，正文文件也都在）'
    }),
    item({
      key: 'foreign-history:foreign:copied:fedcba9876543210', kind: 'foreign-history', name: 'limcode.limcode-copied-2026-09-02T01-02-03-004Z-12345678',
      path: '/data/limcode.limcode-copied-2026-09-02T01-02-03-004Z-12345678/.limcode-runtime', origin: '拷来目录里的库', dataSetCandidateId: undefined,
      dataSetName: undefined, inCurrentDataSet: false, bytes: '8192', reclaimableBytes: '8192', deletable: false, reason: '未通过核验：结构或完整性核验未通过，原样保留'
    }),
    item({
      key: 'copied-data-root:limcode.limcode-copied-2026-09-02T01-02-03-004Z-12345678', kind: 'copied-data-root',
      name: 'limcode.limcode-copied-2026-09-02T01-02-03-004Z-12345678', path: '/data/limcode.limcode-copied-2026-09-02T01-02-03-004Z-12345678',
      dataSetCandidateId: undefined, dataSetName: undefined, inCurrentDataSet: false, bytes: '300', reclaimableBytes: '300', deletable: false,
      reason: '迁移数据目录时挪到旁边的拷来目录。其中的库在“外来历史库”一组里逐个核对，只删能证明内容已完整在本地库里的库；目录本身和其余内容（设置、规则、技能）不删除'
    })
  ]
};

function fixture({ answers = [], plan = PLAN, planError, deleteResult, deleteError, host = true, writeGate, onPlan, warnings, status, statusError } = {}) {
  const calls = [];
  const prompts = [];
  const database = { binding: { dataSetId: 'current' }, snapshot: async () => ({ snapshot: [] }) };
  const vscode = {
    window: {
      async withProgress(options, action) {
        calls.push(['progress', options.title]);
        return action({ report: (value) => calls.push(['progress-report', value.message]) });
      },
      async showInformationMessage(message) { calls.push(['info', message]); },
      async showErrorMessage(message) { calls.push(['error', message]); }
    },
    ProgressLocation: { Notification: 15 },
    commands: { async executeCommand(command, argument) { calls.push(['command', command, argument]); } }
  };
  const application = host
    ? { product: { application: { database } }, dataRootPath: () => ROOT, postToWebview: () => true, ...(writeGate ? { writeGate } : {}) }
    : undefined;
  const startup = { wait: async () => { if (!application) throw new Error('no runtime'); return application; } };
  const dependencies = {
    vscode,
    '../../backend/application/reliableKernel/runtimeWriteGate': writeGateModule,
    '../../backend/reliableKernel/runtimeHostControl': hostControl,
    '../../backend/reliableKernel/runtimeBackupCleanup': {
      formatLocalTime,
      RuntimeBackupCleanupError,
      async planRuntimeBackupCleanup(root, current, options) {
        calls.push(['plan', root, current === database, options.previousDataRootPaths ? [...options.previousDataRootPaths] : null]);
        options.onProgress('正在核对 merge-old…');
        onPlan?.();
        if (planError) throw planError;
        return plan;
      },
      async deleteRuntimeBackups(planned, current, keys) {
        calls.push(['delete', planned === plan, current === database, [...keys]]);
        if (deleteError) throw deleteError;
        return deleteResult ?? {
          deleted: keys.map((key) => { const entry = plan.items.find((candidate) => candidate.key === key); return { key, name: entry.name, path: entry.path, bytes: entry.bytes, reclaimableBytes: entry.reclaimableBytes }; }),
          kept: [], unfinished: [], copiedDirectoriesWithoutDataSets: []
        };
      }
    },
    '../../backend/capabilities/vscodeStorage/globalStatus': {
      async loadCommittedGlobalStatus(context) {
        calls.push(['status', context === extensionContext]);
        if (statusError) throw statusError;
        return status ?? { dataRootPath: ROOT };
      }
    },
    '../../shared/extensionIdentity': { EXTENSION_COMMAND_IDS: { openPanel: 'limcode-test.openPanel', cleanupBackups: 'limcode-test.cleanupBackups' } },
    '../dataRootPrompts': {
      askInSettingsPage(host, clientId, prompt) {
        assert.equal(host, application);
        assert.equal(clientId, 'client-1');
        prompts.push(plain(prompt));
        calls.push(['prompt', prompt.title]);
        const answer = answers.shift();
        return Promise.resolve((typeof answer === 'function' ? answer() : answer) ?? { choice: 'cancel', include: [] });
      }
    },
    '../runtimeDataSetUpgradeLifetime': {
      canStartRuntimeDataSetUpgrade: () => true,
      runRuntimeDataSetUpgrade: (_context, operation) => { calls.push(['lifetime']); return operation(); }
    }
  };
  const command = loadCommand(dependencies, warnings ? { ...console, warn: (...args) => warnings.push(args.map(String).join(' ')) } : console);
  return { calls, prompts, run: (request = { clientId: 'client-1' }) => command.cleanupBackups(extensionContext, startup, request) };
}

test('两步确认：检查有进度通知；第一个面板按种类分组列出、只有可删的项有勾选框；第二个 danger 面板列出将删除的项、合计大小、核对时间和不能撤销', async () => {
  const f = fixture({ answers: [{ choice: 'next', include: ['merge-target:old', 'merge-source:src'] }, { choice: 'delete', include: [] }] });
  await f.run();
  assert.deepEqual(f.calls.filter((call) => call[0] === 'progress').map((call) => call[1]), ['正在检查备份…', '正在删除备份…']);
  assert.ok(f.calls.some((call) => call[0] === 'progress-report' && call[1] === '正在核对 merge-old…'), '检查过程报告进度');
  assert.deepEqual(f.calls.find((call) => call[0] === 'plan'), ['plan', ROOT, true, null], '经本窗口打开的当前库读取；没有迁移过就只看当前数据目录');

  const [first, second, done] = f.prompts;
  assert.equal(first.title, '清理备份：勾选要删除的备份');
  assert.match(first.description, /只删除能证明完整存在于本地库的副本/);
  assert.match(first.description, /工具调用、输出、回答等记录都还在当前库或同一数据目录的某个历史库里，正文文件也在，副本里显示的每条消息在那里也显示同一个版本/);
  assert.match(first.description, /已被你删除、编辑或重试替换的，单独列出，默认不勾选/);
  assert.doesNotMatch(first.description, /包括编辑前的版本/, '不再说编辑前的版本都还在：被替换的消息单独列出');
  assert.deepEqual(first.actions.map((action) => action.key), ['cancel', 'next']);
  assert.equal(first.danger, undefined);
  assert.equal(first.options, undefined, '勾选框按种类放在各自的分组里');
  assert.deepEqual(first.sections.slice(1).map((section) => section.title), [
    '升级前备份（1 项）', '合并前备份（2 项）', '合并来源的收尾前备份（1 项）', '外来历史库（2 项）',
    '归档目录里的其它内容（只列出）（1 项）', '拷来目录（只列出）（1 项）'
  ]);
  const merge = first.sections.find((section) => section.title === '合并前备份（2 项）');
  assert.match(merge.lines[0], /^用途：/);
  assert.deepEqual(merge.options.map((option) => [option.key, option.checked]), [['merge-target:old', true]], '内容完整的项默认勾选');
  assert.match(merge.options[0].label, /^merge-old（2 KiB，预计释放 1 KiB）$/);
  assert.match(merge.options[0].detail, /创建于 2026-09-\d\d \d\d:\d\d.*所属：当前库　位置：\/data\/limcode\/\.limcode-runtime\/merge-backups\/merge-old.*可以删除：内容已完整在当前库里/);
  const source = first.sections.find((section) => section.title === '合并来源的收尾前备份（1 项）');
  assert.match(source.options[0].detail, /所属：历史库“项目甲”　位置：/, '所属用“历史与存储管理”里的名字，不写 id');
  assert.doesNotMatch(JSON.stringify(first), /workspace:folder-x/);
  assert.ok(merge.lines.some((line) => line.startsWith('merge-newest（2 KiB）') && line.endsWith('不删除：这是这个库最新的一份满 1 小时的完整合并前备份，保留')));
  const upgrade = first.sections.find((section) => section.title === '升级前备份（1 项）');
  assert.deepEqual(upgrade.options, [], '不可删的项没有勾选框');
  assert.ok(upgrade.lines.some((line) => line.includes('不删除：含 3 个当前库没有的对话（可能是你删掉的），按历史保留')));
  const archive = first.sections.find((section) => section.title?.startsWith('归档目录里的其它内容'));
  assert.ok(archive.lines.some((line) => line.includes('位置：/data/limcode/.limcode-runtime-backups/') && line.includes('（100 B）')));
  assert.ok(archive.lines.every((line) => !line.includes('当前库') && !line.includes('所属：')), '只列出的归档不是当前库的一部分，位置只写路径');
  assert.ok(first.sections[0].lines.includes('已删完上次没有删完的 1 项。'));
  assert.ok(first.sections[0].lines.some((line) => line.startsWith('可以删除 3 项，合计 1 MiB') && line.endsWith('默认都勾选，可以取消。')));

  assert.equal(second.title, '永久删除所选备份？');
  assert.equal(second.danger, true);
  assert.deepEqual(second.actions, [{ key: 'cancel', label: '取消', variant: 'secondary' }, { key: 'delete', label: '永久删除', variant: 'danger' }]);
  assert.equal(second.sections[0].title, '将删除 2 项，合计 1 MiB（预计释放 1 MiB）：');
  assert.deepEqual(second.sections[0].lines.map((line) => line.split('（')[0]), ['merge-old', 'source']);
  assert.match(second.sections[1].lines.join('\n'), /核对时间：2026-09-27 \d\d:\d\d。删除前会在锁内再核对一遍/);
  assert.match(second.sections[1].lines.join('\n'), /不能撤销/);

  assert.deepEqual(f.calls.find((call) => call[0] === 'delete'), ['delete', true, true, ['merge-target:old', 'merge-source:src']]);
  assert.equal(done.title, '备份已删除');
  assert.match(done.sections[0].lines[0], /^已删除 2 项/);
  assert.equal(f.calls.filter((call) => call[0] === 'lifetime').length, 2, '检查与删除都登记为本窗口的数据操作');
});

test('含你后来删除或替换的内容单独一组（审查 H1）：默认不勾选、写明条数，内容完整的默认勾选；第二步写明其中几项、共几条消息删除后再也看不到；明确勾选之后才删', async () => {
  const replacedItem = item({
    key: 'merge-target:replaced', name: 'merge-replaced', path: `${CONTROL}/merge-backups/merge-replaced`, replacedMessages: 2,
    reason: '其中 2 条消息在当前库里已被你删除、编辑或重试替换，删除这份后它们就再也看不到了'
  });
  const replacedForeign = item({
    key: 'foreign-history:foreign:archive:1111111111111111', kind: 'foreign-history', name: '20260902-010203-004-abcdef13',
    path: `${ROOT}/.limcode-runtime-backups/20260902-010203-004-abcdef13`, origin: '“归档并重置”的归档', dataSetCandidateId: undefined,
    dataSetName: undefined, inCurrentDataSet: false, replacedMessages: 1,
    reason: '其中 1 条消息在历史库“项目甲”里已被你删除、编辑或重试替换，删除这份后它们就再也看不到了'
  });
  const plan = { ...PLAN, items: [...PLAN.items, replacedItem, replacedForeign] };
  const chosen = ['merge-target:old', 'merge-target:replaced', 'foreign-history:foreign:archive:1111111111111111'];
  const f = fixture({ plan, answers: [{ choice: 'next', include: chosen }, { choice: 'delete', include: [] }] });
  await f.run();
  const [first, second] = f.prompts;
  assert.deepEqual(first.sections.slice(1).map((section) => section.title), [
    '升级前备份（1 项）', '合并前备份（2 项）', '合并来源的收尾前备份（1 项）', '外来历史库（2 项）', '含你后来删除或替换的内容（2 项）',
    '归档目录里的其它内容（只列出）（1 项）', '拷来目录（只列出）（1 项）'
  ], '紧跟在可以证明的几种之后');
  const group = first.sections.find((section) => section.title === '含你后来删除或替换的内容（2 项）');
  assert.match(group.lines[0], /^用途：内容都还在当前库或某个历史库里，但其中一些消息在那里已被你删除、编辑或重试替换，只在这份副本里还能看到；默认不勾选/);
  assert.deepEqual(group.options.map((option) => [option.key, option.checked]), [
    ['merge-target:replaced', undefined], ['foreign-history:foreign:archive:1111111111111111', undefined]
  ], '默认不勾选');
  assert.match(group.options[0].detail, /所属：当前库　位置：.*其中 2 条消息在当前库里已被你删除、编辑或重试替换，删除这份后它们就再也看不到了$/);
  assert.match(group.options[1].detail, /来源：“归档并重置”的归档　位置：.*其中 1 条消息在历史库“项目甲”里已被你删除/);
  const merge = first.sections.find((section) => section.title === '合并前备份（2 项）');
  assert.deepEqual(merge.options.map((option) => [option.key, option.checked]), [['merge-target:old', true]], '替换组的项不在它的种类里重复出现');
  assert.ok(first.sections[0].lines.some((line) => line.startsWith('可以删除 5 项')
    && line.endsWith('内容完整的 3 项默认勾选，含你后来删除或替换的内容的 2 项默认不勾选。')), first.sections[0].lines.join('\n'));
  assert.equal(second.sections[1].lines[0], '其中 2 项含你后来删除或替换的内容（共 3 条消息），删除后这些消息就再也看不到了。');
  assert.deepEqual(f.calls.find((call) => call[0] === 'delete')[3], chosen);

  // Only the complete ones ticked (as the panel opens): nothing of the replaced group is deleted, and no warning line.
  const ticked = fixture({ plan, answers: [{ choice: 'next', include: ['merge-target:old'] }, { choice: 'delete', include: [] }] });
  await ticked.run();
  assert.deepEqual(ticked.calls.find((call) => call[0] === 'delete')[3], ['merge-target:old']);
  assert.doesNotMatch(ticked.prompts[1].sections[1].lines.join('\n'), /含你后来删除或替换的内容/);
});

test('第一步取消、第二步取消、没有勾选任何一项：都不删除；勾选以外的键不会传给删除', async () => {
  for (const answers of [
    [{ choice: 'cancel', include: ['merge-target:old'] }],
    [{ choice: 'next', include: ['merge-target:old'] }, { choice: 'cancel', include: [] }],
    [{ choice: 'next', include: [] }]
  ]) {
    const f = fixture({ answers });
    await f.run();
    assert.equal(f.calls.some((call) => call[0] === 'delete'), false, JSON.stringify(answers));
  }
  const f = fixture({ answers: [{ choice: 'next', include: [] }] });
  await f.run();
  assert.equal(f.prompts.at(-1).title, '没有选择要删除的备份');
  const forged = fixture({ answers: [{ choice: 'next', include: ['epoch-migration:up', 'reset-archive:arch', 'merge-target:old'] }, { choice: 'delete', include: [] }] });
  await forged.run();
  assert.deepEqual(forged.calls.find((call) => call[0] === 'delete')[3], ['merge-target:old'], '不可删的项即使被勾选也不传给删除');
});

test('没有可删的项：只有“知道了”，不出现第二个确认；检查失败时说明原因且不删除', async () => {
  const none = fixture({ plan: { ...PLAN, items: PLAN.items.filter((entry) => !entry.deletable) }, answers: [{ choice: 'next', include: ['merge-target:old'] }] });
  await none.run();
  assert.equal(none.prompts.length, 1);
  assert.equal(none.prompts[0].title, '清理备份：没有可以删除的备份');
  assert.deepEqual(none.prompts[0].actions.map((action) => action.label), ['知道了']);
  assert.equal(none.calls.some((call) => call[0] === 'delete'), false);

  const failed = fixture({ planError: Object.assign(new Error('ENOSPC: no space left on device, write'), { code: 'ENOSPC' }) });
  await failed.run();
  assert.deepEqual([failed.prompts[0].title, failed.prompts[0].sections[0].lines],
    ['备份检查没有完成', ['检查时磁盘空间不足（详细原因已写入日志），腾出空间后再试。', '没有删除任何内容。']]);
  assert.equal(failed.calls.some((call) => call[0] === 'delete'), false);
});

test('盲审 #5 整个检查或删除没有完成时：面板上只写中文原因，技术原因只写进日志；本来就写给用户的拒绝原样显示', async () => {
  const shown = async (error, answers = []) => {
    const warnings = [];
    const f = fixture({ warnings, planError: error, answers });
    await f.run();
    return { lines: f.prompts[0].sections[0].lines, warnings, prompts: f.prompts };
  };
  const denied = await shown(Object.assign(new Error("EACCES: permission denied, scandir '/data/limcode/.limcode-workspace-runtimes/scopes'"), { code: 'EACCES' }));
  assert.deepEqual(denied.lines, ['检查时没有权限读取或修改数据目录里的某个位置（详细原因已写入日志）。', '没有删除任何内容。']);
  assert.doesNotMatch(JSON.stringify(denied.prompts), /EACCES|scandir|permission denied/);
  assert.ok(denied.warnings.some((line) => line.includes('EACCES: permission denied')), denied.warnings.join('\n'));
  const unknown = await shown(new TypeError("Cannot read properties of undefined (reading 'binding')"));
  assert.deepEqual(unknown.lines, ['检查时遇到意外的错误（详细原因已写入日志），稍后再试。', '没有删除任何内容。']);
  assert.ok(unknown.warnings.some((line) => line.includes("reading 'binding'")), unknown.warnings.join('\n'));
  const busy = await shown(new hostControl.RuntimeMaintenanceBusyError('/data/limcode/.limcode-runtime.runtime-admission', {
    claimToken: 't', processId: 1234, startedAt: '2026-09-27T00:00:00.000Z', rootPointerPath: '/data/limcode/.limcode-runtime/root-binding.json'
  }, 'identity unknown'));
  assert.deepEqual(busy.lines, ['另一个窗口正在维护数据目录，而且无法确认它的状态，这次没有继续，稍后再试。', '没有删除任何内容。']);
  const stopped = await shown(Object.assign(new Error('Extension shutdown has stopped admitting Runtime data-set upgrades.'), { code: 'runtime-dataset-upgrades-stopped' }));
  assert.deepEqual(stopped.lines, ['窗口正在关闭，没有继续。', '没有删除任何内容。']);
  // Written for the user already: shown as it is, nothing logged as unexpected.
  const refused = await shown(new RuntimeBackupCleanupError('这份备份清单不是本窗口刚才核对的结果，请重新检查。'));
  assert.deepEqual([refused.lines, refused.warnings], [['这份备份清单不是本窗口刚才核对的结果，请重新检查。', '没有删除任何内容。'], []]);

  // The deletion as a whole failed: the same, for 删除.
  const warnings = [];
  const failing = fixture({
    warnings,
    answers: [{ choice: 'next', include: ['merge-target:old'] }, { choice: 'delete', include: [] }],
    deleteError: Object.assign(new Error('EPERM: operation not permitted, rename'), { code: 'EPERM' })
  });
  await failing.run();
  assert.equal(failing.prompts.at(-1).title, '备份没有删除');
  assert.deepEqual(failing.prompts.at(-1).sections[0].lines, ['删除时没有权限读取或修改数据目录里的某个位置（详细原因已写入日志）。']);
  assert.ok(warnings.some((line) => line.includes('EPERM: operation not permitted')), warnings.join('\n'));
});

test('删除时锁内复核没有通过的项：结果面板逐项写明保留原因', async () => {
  const f = fixture({
    answers: [{ choice: 'next', include: ['merge-target:old'] }, { choice: 'delete', include: [] }],
    deleteResult: { deleted: [], kept: [{ key: 'merge-target:old', name: 'merge-old', path: '/x', reason: '列出之后这份备份有变化，请重新检查；这一项没有删除' }], unfinished: [] }
  });
  await f.run();
  const done = f.prompts.at(-1);
  assert.equal(done.title, '没有删除任何备份');
  assert.deepEqual(done.sections[0].lines, ['merge-old 保留：列出之后这份备份有变化，请重新检查；这一项没有删除']);
});

test('没有设置页（命令面板、历史与存储管理的入口）：只打开设置页并指明位置；没有运行时时报错', async () => {
  const f = fixture();
  await f.run({});
  assert.deepEqual(plain(f.calls), [
    ['command', 'limcode-test.openPanel', { kind: 'globalSettings', reuse: true }],
    ['info', '请在设置页“其他 → 数据目录”一栏点“清理备份…”。']
  ]);
  const offline = fixture({ host: false });
  await offline.run();
  assert.deepEqual(plain(offline.calls), [['error', '运行时没有打开，不能清理备份。']]);
});

test('设置页的回答只接受这一个确认面板上列出的勾选项（包括分组里的勾选项）', () => {
  const filename = path.resolve(__dirname, '../../vscode/dataRootPrompts.ts');
  const module = { exports: {} };
  vm.runInNewContext(ts.transpileModule(fs.readFileSync(filename, 'utf8'), {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS }
  }).outputText, {
    module, exports: module.exports,
    require(name) {
      if (name === 'node:crypto') return require('node:crypto');
      if (name === '../shared/protocol') return { BridgeMessageType: { DataRootPrompt: 'dataRoot.prompt' } };
      throw new Error(`Unexpected source dependency: ${name}`);
    }
  }, { filename });
  const posted = [];
  const answer = module.exports.askInSettingsPage({ postToWebview: (_client, message) => { posted.push(message); return true; } }, 'client-1', {
    title: '清理备份', actions: [{ key: 'next', label: '下一步' }],
    options: [{ key: 'flat', label: '平铺的勾选项' }],
    sections: [{ title: '合并前备份', lines: [], options: [{ key: 'grouped', label: '分组里的勾选项' }] }]
  });
  const flowId = posted[0].payload.flowId;
  assert.equal(module.exports.answerDataRootPrompt('client-2', { flowId, choice: 'next', include: ['grouped'] }), false, '别的页面不能回答');
  assert.equal(module.exports.answerDataRootPrompt('client-1', { flowId, choice: 'next', include: ['grouped', 'flat', 'forged'] }), true);
  return answer.then((result) => assert.deepEqual(plain(result), { choice: 'next', include: ['grouped', 'flat'] }));
});

test('冻结期间（本窗口正在迁移数据目录等）清理备份按写命令拒绝：入口就说明，不检查也不删除；确认之后才冻结的，删除同样被拒绝', async () => {
  const gate = new RuntimeWriteGate();
  const thaw = gate.freeze('迁移数据目录', []);
  const refused = fixture({ writeGate: gate });
  await refused.run();
  assert.ok(!refused.calls.some((call) => ['plan', 'delete', 'lifetime'].includes(call[0])), '什么都不检查、不删除');
  assert.deepEqual(refused.prompts.map((prompt) => prompt.title), ['现在不能清理备份']);
  assert.deepEqual(refused.prompts[0].sections[0].lines, ['正在迁移数据目录，完成后再操作。', '没有删除任何内容。']);
  thaw();

  let thawLate;
  const late = fixture({
    writeGate: gate,
    answers: [{ choice: 'next', include: ['merge-target:old'] }, () => { thawLate = gate.freeze('迁移数据目录', []); return { choice: 'delete', include: [] }; }]
  });
  await late.run();
  thawLate();
  assert.ok(!late.calls.some((call) => call[0] === 'delete'), '删除前冻结：不删除');
  assert.equal(late.prompts.at(-1).title, '备份没有删除');
  assert.match(JSON.stringify(late.prompts.at(-1)), /正在迁移数据目录，完成后再操作。/);

  const open = fixture({ writeGate: gate, answers: [{ choice: 'next', include: ['merge-target:old'] }, { choice: 'delete', include: [] }] });
  await open.run();
  assert.deepEqual(open.calls.find((call) => call[0] === 'delete')?.[3], ['merge-target:old'], '解冻后照常删除');
});

test('检查进行中开始冻结（迁移数据目录的 beforeGo）：检查按写命令计入冻结基线', async () => {
  const gate = new RuntimeWriteGate();
  let baseline;
  let thaw;
  const f = fixture({
    writeGate: gate,
    onPlan() {
      // The check may be settling leftovers of an interrupted cleanup or copying another data set right now.
      thaw = gate.freeze('迁移数据目录', []);
      baseline = gate.frozenBaseline();
    }
  });
  await f.run();
  thaw?.();
  assert.ok(baseline, '检查期间发生了冻结');
  assert.equal(baseline.writesRunning, true, '冻结时这次检查算作仍在进行的写命令');
});

test('检查结果：上次中断、改回原名的项写在面板上；技术原因只写进日志，不显示在面板上', async () => {
  const warnings = [];
  const f = fixture({
    warnings,
    plan: {
      ...PLAN,
      restoredDeletions: [`${CONTROL}/merge-backups/merge-old`],
      problems: ['/data/limcode/.limcode-runtime 里的备份没有全部列出。'],
      details: ['/data/limcode/.limcode-runtime 里的备份没有全部列出。 EACCES: permission denied, scandir'],
      items: [...PLAN.items, item({
        key: 'merge-target:bad', name: 'merge-bad', deletable: false, reason: '这份备份的数据库已损坏，无法核对，按历史保留',
        detail: 'SQLITE_CORRUPT: database disk image is malformed'
      })]
    }
  });
  await f.run();
  const first = f.prompts[0];
  assert.ok(first.sections[0].lines.includes('上次清理在最后一次核对之前中断：1 项已改回原名，按这次的核对结果列出。'));
  assert.ok(first.sections[0].lines.includes('/data/limcode/.limcode-runtime 里的备份没有全部列出。'));
  assert.doesNotMatch(JSON.stringify(first), /SQLITE_CORRUPT|EACCES/);
  assert.ok(warnings.some((line) => line.includes('merge-bad') && line.includes('SQLITE_CORRUPT')), warnings.join('\n'));
  assert.ok(warnings.some((line) => line.includes('EACCES')), warnings.join('\n'));
});

test('外来历史库单独一组：可删的写明来源、位置和内容已完整在哪个库，不可删的写明原因；离开过的数据目录交给检查；删除后拷来目录里没有库时写明其余内容保留', async () => {
  const COPIED = '/data/limcode.limcode-copied-2026-09-02T01-02-03-004Z-12345678';
  const f = fixture({
    status: { dataRootPath: ROOT, lastMigration: { fromPath: '/old/limcode' } },
    answers: [
      { choice: 'next', include: ['foreign-history:foreign:archive:0123456789abcdef', 'foreign-history:foreign:copied:fedcba9876543210', 'copied-data-root:limcode.limcode-copied-2026-09-02T01-02-03-004Z-12345678'] },
      { choice: 'delete', include: [] }
    ],
    deleteResult: {
      deleted: [{
        key: 'foreign-history:foreign:archive:0123456789abcdef', name: '20260901-010203-004-abcdef12',
        path: `${ROOT}/.limcode-runtime-backups/20260901-010203-004-abcdef12`, bytes: '4096', reclaimableBytes: '4096'
      }],
      kept: [], unfinished: [],
      copiedDirectoriesWithoutDataSets: [{ name: 'limcode.limcode-copied-2026-09-02T01-02-03-004Z-12345678', path: COPIED }]
    }
  });
  await f.run();
  assert.deepEqual(f.calls.find((call) => call[0] === 'plan'), ['plan', ROOT, true, ['/old/limcode']], '最近一次迁移离开的目录的归档和旁边的拷来目录一起核对');
  assert.deepEqual(f.calls.find((call) => call[0] === 'status'), ['status', true]);
  const [first, second, done] = f.prompts;
  assert.match(first.description, /外来历史库还要先通过核验/);
  const foreign = first.sections.find((section) => section.title === '外来历史库（2 项）');
  assert.match(foreign.lines[0], /^用途：“归档并重置”留下的归档，和迁移数据目录时挪到旁边的拷来目录里的库；只有核验通过/);
  assert.deepEqual(foreign.options.map((option) => option.key), ['foreign-history:foreign:archive:0123456789abcdef']);
  assert.match(foreign.options[0].detail,
    /来源：“归档并重置”的归档　位置：\/data\/limcode\/\.limcode-runtime-backups\/20260901-010203-004-abcdef12　可以删除：内容已完整在当前库里/);
  assert.ok(foreign.lines.some((line) => line.includes('来源：拷来目录里的库　位置：/data/limcode.limcode-copied-') && line.includes('不删除：未通过核验：')), foreign.lines.join('\n'));
  const copied = first.sections.find((section) => section.title === '拷来目录（只列出）（1 项）');
  assert.deepEqual(copied.options, [], '拷来目录整体永远不能勾选');
  assert.ok(copied.lines.some((line) => line.includes(`位置：${COPIED}`) && line.includes('目录本身和其余内容（设置、规则、技能）不删除')));
  assert.deepEqual(f.calls.find((call) => call[0] === 'delete')[3], ['foreign-history:foreign:archive:0123456789abcdef'], '未通过核验的库与拷来目录即使被勾选也不传给删除');
  assert.deepEqual(second.sections[0].lines, [`20260901-010203-004-abcdef12（4 KiB）　${ROOT}/.limcode-runtime-backups/20260901-010203-004-abcdef12`]);
  assert.deepEqual(done.sections[0].lines, [
    '已删除 1 项，合计 4 KiB（预计释放 4 KiB）。',
    `拷来目录 limcode.limcode-copied-2026-09-02T01-02-03-004Z-12345678 里已经没有库；其余内容（设置、规则、技能）保留，可自行处理。位置：${COPIED}`
  ]);
});

test('最后一轮 #5 连续迁移之后：离开过的数据目录（globalStatus 的列表，加上最近一次迁移离开的目录）都交给检查，和外来历史库的发现一致', async () => {
  const f = fixture({
    status: { dataRootPath: ROOT, lastMigration: { fromPath: '/b/limcode' }, previousDataRoots: ['/b/limcode', '/a/limcode'] },
    answers: [{ choice: 'cancel', include: [] }]
  });
  await f.run();
  assert.deepEqual(f.calls.find((call) => call[0] === 'plan'), ['plan', ROOT, true, ['/b/limcode', '/a/limcode']], 'A→B→C 之后 A 也核对');
  const older = fixture({ status: { dataRootPath: ROOT, lastMigration: { fromPath: '/b/limcode' }, previousDataRoots: ['/a/limcode'] }, answers: [{ choice: 'cancel', include: [] }] });
  await older.run();
  assert.deepEqual(older.calls.find((call) => call[0] === 'plan'), ['plan', ROOT, true, ['/a/limcode', '/b/limcode']]);
});

test('读不出以前的数据目录的位置时只核对当前数据目录，照常检查，原因只写进日志', async () => {
  const warnings = [];
  const f = fixture({ warnings, statusError: new Error('globalStatus.json 无法解析'), answers: [{ choice: 'cancel', include: [] }] });
  await f.run();
  assert.deepEqual(f.calls.find((call) => call[0] === 'plan'), ['plan', ROOT, true, null]);
  assert.equal(f.prompts[0].title, '清理备份：勾选要删除的备份');
  assert.ok(warnings.some((line) => line.includes('globalStatus.json 无法解析')), warnings.join('\n'));
  assert.doesNotMatch(JSON.stringify(f.prompts), /globalStatus/);
});
