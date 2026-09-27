const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const test = require('node:test');
const ts = require('typescript');

const compiled = path.resolve(process.env.LIMCODE_TEST_EXTENSION_ROOT ?? 'dist/extension');
const { RuntimeWriteGate } = require(path.join(compiled, 'backend/application/reliableKernel/runtimeWriteGate.js'));

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
const CONTROL = `${ROOT}/.limcode-runtime`;
const plain = (value) => JSON.parse(JSON.stringify(value));

function item(overrides) {
  return {
    key: 'merge-target:.limcode-runtime/merge-backups/a', kind: 'merge-target', name: 'a', path: `${CONTROL}/merge-backups/a`,
    dataSetCandidateId: 'default', inCurrentDataSet: true, bytes: '2048', reclaimableBytes: '1024', fileCount: 2,
    createdAt: '2026-09-20T01:02:00.000Z', deletable: true, reason: '可以删除：其中 2 个对话、4 个消息版本都完整存在于当前库', ...overrides
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
      dataSetCandidateId: 'workspace:folder-x', inCurrentDataSet: false, bytes: '1048576', reclaimableBytes: '1048576',
      reason: '可以删除：其中 1 个对话、2 个消息版本都完整存在于这个历史库（workspace:folder-x）'
    }),
    item({
      key: 'reset-archive:arch', kind: 'reset-archive', name: '20260901-010203-004-abcdef12', path: `${ROOT}/.limcode-runtime-backups/20260901-010203-004-abcdef12`,
      inCurrentDataSet: false, bytes: '100', reclaimableBytes: '100', deletable: false, reason: '“归档并重置”时整份保留的历史库，含当时的对话；可在“历史与存储管理 → 外来历史库”里查看（核验通过的可以只读打开），以后的版本支持合并；本版本只列出，不删除'
    })
  ]
};

function fixture({ answers = [], plan = PLAN, planError, deleteResult, host = true, writeGate, onPlan, warnings } = {}) {
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
    '../../backend/reliableKernel/runtimeBackupCleanup': {
      async planRuntimeBackupCleanup(root, current, options) {
        calls.push(['plan', root, current === database]);
        options.onProgress('正在核对 merge-old…');
        onPlan?.();
        if (planError) throw planError;
        return plan;
      },
      async deleteRuntimeBackups(planned, current, keys) {
        calls.push(['delete', planned === plan, current === database, [...keys]]);
        return deleteResult ?? {
          deleted: keys.map((key) => { const entry = plan.items.find((candidate) => candidate.key === key); return { key, name: entry.name, path: entry.path, bytes: entry.bytes, reclaimableBytes: entry.reclaimableBytes }; }),
          kept: [], unfinished: []
        };
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
  return { calls, prompts, run: (request = { clientId: 'client-1' }) => command.cleanupBackups({}, startup, request) };
}

test('两步确认：检查有进度通知；第一个面板按种类分组列出、只有可删的项有勾选框；第二个 danger 面板列出将删除的项、合计大小、核对时间和不能撤销', async () => {
  const f = fixture({ answers: [{ choice: 'next', include: ['merge-target:old', 'merge-source:src'] }, { choice: 'delete', include: [] }] });
  await f.run();
  assert.deepEqual(f.calls.filter((call) => call[0] === 'progress').map((call) => call[1]), ['正在检查备份…', '正在删除备份…']);
  assert.ok(f.calls.some((call) => call[0] === 'progress-report' && call[1] === '正在核对 merge-old…'), '检查过程报告进度');
  assert.deepEqual(f.calls.find((call) => call[0] === 'plan'), ['plan', ROOT, true], '经本窗口打开的当前库读取');

  const [first, second, done] = f.prompts;
  assert.equal(first.title, '清理备份：勾选要删除的备份');
  assert.match(first.description, /只删除能证明完整存在于本地库的副本/);
  assert.deepEqual(first.actions.map((action) => action.key), ['cancel', 'next']);
  assert.equal(first.danger, undefined);
  assert.equal(first.options, undefined, '勾选框按种类放在各自的分组里');
  assert.deepEqual(first.sections.slice(1).map((section) => section.title), [
    '升级前备份（1 项）', '合并前备份（2 项）', '合并来源的收尾前备份（1 项）', '“归档并重置”的归档（只列出）（1 项）'
  ]);
  const merge = first.sections.find((section) => section.title === '合并前备份（2 项）');
  assert.match(merge.lines[0], /^用途：/);
  assert.deepEqual(merge.options.map((option) => option.key), ['merge-target:old']);
  assert.match(merge.options[0].label, /^merge-old（2 KiB，预计释放 1 KiB）$/);
  assert.match(merge.options[0].detail, /创建于 2026-09-\d\d \d\d:\d\d.*所属：当前库　位置：\/data\/limcode\/\.limcode-runtime\/merge-backups\/merge-old.*可以删除：其中 2 个对话/);
  assert.ok(merge.lines.some((line) => line.startsWith('merge-newest（2 KiB）') && line.endsWith('不删除：这是这个库最新的一份满 1 小时的完整合并前备份，保留')));
  const upgrade = first.sections.find((section) => section.title === '升级前备份（1 项）');
  assert.deepEqual(upgrade.options, [], '不可删的项没有勾选框');
  assert.ok(upgrade.lines.some((line) => line.includes('不删除：含 3 个当前库没有的对话（可能是你删掉的），按历史保留')));
  const archive = first.sections.find((section) => section.title?.startsWith('“归档并重置”'));
  assert.ok(archive.lines.some((line) => line.includes('位置：/data/limcode/.limcode-runtime-backups/') && line.includes('（100 B）')));
  assert.ok(archive.lines.every((line) => !line.includes('当前库') && !line.includes('所属：')), '只列出的归档不是当前库的一部分，位置只写路径');
  assert.ok(first.sections[0].lines.includes('已删完上次没有删完的 1 项。'));
  assert.ok(first.sections[0].lines.some((line) => line.startsWith('可以删除 2 项，合计 1 MiB') && line.includes('默认都不勾选')));

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

  const failed = fixture({ planError: new Error('磁盘已满') });
  await failed.run();
  assert.deepEqual([failed.prompts[0].title, failed.prompts[0].sections[0].lines], ['备份检查没有完成', ['磁盘已满', '没有删除任何内容。']]);
  assert.equal(failed.calls.some((call) => call[0] === 'delete'), false);
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
