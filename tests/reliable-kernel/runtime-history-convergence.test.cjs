const assert = require('node:assert/strict');
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const vm = require('node:vm');
const test = require('node:test');
const ts = require('typescript');

function load(relative, dependencies) {
  const module = { exports: {} };
  vm.runInNewContext(ts.transpileModule(fs.readFileSync(path.resolve(__dirname, '../..', relative), 'utf8'), {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS }
  }).outputText, { module, exports: module.exports, AbortController, require: name => dependencies[name] ?? require(name) });
  return module.exports;
}

test('收敛登记仅入队新来源，残留须显式重试，通知来源跨重启去重', async () => {
  const foreign = [];
  const records = new Map(), pending = new Map(), residual = new Map([['reset', {}]]);
  const candidates = [{ id: 'current', selected: true }, { id: 'old', selected: false }, { id: 'reset', selected: false }];
  const api = load('backend/reliableKernel/runtimeHistoryConvergence.ts', {
    'node:fs/promises': { readFile: async file => { if (!records.has(file)) throw Object.assign(new Error(), { code: 'ENOENT' }); return JSON.stringify(records.get(file)); } },
    './runtimeHostControl': { withRuntimeDataRootAdmission: async (_, run) => run() },
    './runtimeForeignHistory': { discoverForeignRuntimeHistory: async () => foreign, heldDatabaseFiles: async () => new Set(), readForeignRuntimePointerIdentity: async () => ({ dataSetId: 'data', rootInstanceId: 'root' }) },
    './vscodeRootAuthority': { inspectVscodeRuntimeDataSets: async () => ({ candidates }) },
    './runtimeDataSetMergeLedger': { ledgerFile: async (_, section, id) => `${section}/${id}`, writeLedgerJson: async (_, section, id, value) => records.set(`${section}/${id}`, value),
      readRuntimeDataSetMergeLedgerRecord: async (_, id) => records.get(`records/${id}`),
      sameRuntimeDataSetIdentity: (a, b) => !!a && !!b && a.dataSetId === b.dataSetId && a.rootInstanceId === b.rootInstanceId,
      runtimeDataSetMergeSourceUnchanged: async candidate => candidate.unchanged === true },
    './runtimeHistoryRegistry': { readRuntimeHistoryPending: async () => pending, readRuntimeHistoryResidual: async () => residual,
      writeRuntimeHistoryPending: async (_, item) => pending.set(item.id, item), reconcileRuntimeResetBackups: async () => {} }
  });
  assert.equal(await api.registerRuntimeHistoryConvergence({ globalStoragePath: '/fixture' }), 1);
  assert.deepEqual([...pending.keys()], ['old']);
  pending.delete('old'); // completed source must not be enqueued on every startup
  assert.equal(await api.registerRuntimeHistoryConvergence({ globalStoragePath: '/fixture' }), 0);
  assert.equal(pending.size, 0);
  candidates.push({ id: 'new', selected: false });
  assert.equal(await api.registerRuntimeHistoryConvergence({ globalStoragePath: '/fixture' }), 1);
  foreign.push({ id: 'foreign:archive:aaaaaaaaaaaaaaaa', location: { kind: 'archive' } });
  assert.equal(await api.registerRuntimeHistoryConvergence({ globalStoragePath: '/fixture' }), 1);
  pending.delete(foreign[0].id);
  residual.set(foreign[0].id, { sourceKind: 'archive' });
  assert.equal(await api.registerRuntimeHistoryConvergence({ globalStoragePath: '/fixture' }), 0);
  assert.equal(pending.has(foreign[0].id), false, '外来残留不会在启动时自动重新入队');
  foreign.push({ id: 'foreign:copied:bbbbbbbbbbbbbbbb', location: { kind: 'copied' } });
  assert.equal(await api.registerRuntimeHistoryConvergence({ globalStoragePath: '/fixture' }), 1);
  assert.equal(pending.has(foreign[1].id), true, '新发现的正常来源继续登记');
  residual.delete(foreign[0].id);
  pending.set(foreign[0].id, { reason: '用户在残留列表里选择重新合并' });
  await api.registerRuntimeHistoryConvergence({ globalStoragePath: '/fixture' });
  assert.equal(pending.get(foreign[0].id).reason, '用户在残留列表里选择重新合并');
  const target = { dataSetId: 'current-data', rootInstanceId: 'current-root' };
  Object.assign(candidates[0], target);
  for (const [id, state, unchanged, differentTarget] of [
    ['already-merged', 'merged', true, false], ['updated-source', 'merged', false, false],
    ['partial-source', 'partial', true, false], ['another-target', 'merged', true, true]
  ]) {
    candidates.push({ id, selected: false, unchanged });
    records.set(`records/${id}`, { state, target: differentTarget ? { dataSetId: 'other', rootInstanceId: 'root' } : target });
  }
  await api.registerRuntimeHistoryConvergence({ globalStoragePath: '/fixture' });
  assert.equal(pending.has('already-merged'), false, '旧成功账本且来源未变，不因首次建立收敛登记重复入队');
  for (const id of ['updated-source', 'partial-source', 'another-target']) assert.equal(pending.has(id), true, id);
  assert.ok(records.get('/convergence').sourceIds.includes('already-merged'));

});

test('收尾同意落盘并绑定来源身份及用户看到的数量', async () => {
  const base = process.env.LIMCODE_TEST_EXTENSION_ROOT ?? path.resolve(__dirname, '../../dist/extension');
  const api = require(path.join(base, 'backend/reliableKernel/runtimeHistoryConvergence.js'));
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), 'history-consent-'));
  const paths = { globalStoragePath: root };
  const input = { candidateId: 'workspace:old', dataSetId: 'data', rootInstanceId: 'root', turns: 2, intents: 3 };
  try {
    assert.equal(await api.readRuntimeHistorySettlementConsent(paths, input), false);
    await api.recordRuntimeHistorySettlementConsent(paths, input);
    assert.equal(await api.readRuntimeHistorySettlementConsent(paths, input), true);
    assert.equal(await api.readRuntimeHistorySettlementConsent(paths, { ...input, turns: 3 }), false);
    assert.equal(await api.readRuntimeHistorySettlementConsent(paths, { ...input, effects: 1 }), false);
    assert.equal(await api.readRuntimeHistorySettlementConsent(paths, { ...input, rootInstanceId: 'replacement' }), false);
    assert.ok(JSON.parse(await fsp.readFile(path.join(root, '.limcode-runtime-merges/settlement-consent.json'), 'utf8')).sources[0].agreedAt);
  } finally { await fsp.rm(root, { recursive: true, force: true }); }
});

test('部分合并只读列表跨过已合并页面，只暴露剔除对话并释放原查看登记', async () => {
  const api = load('vscode/commands/runtimeHistoryResiduals.ts', {
    vscode: {}, '../../backend/capabilities/vscodeStorage/globalStatus': {}, '../../backend/capabilities/vscodeStorage/paths': {},
    '../../backend/reliableKernel/vscodeRootAuthority': {},
    '../../backend/reliableKernel/runtimeDataSetHistory': {}, '../../backend/reliableKernel/runtimeForeignHistory': {},
    '../../backend/reliableKernel/runtimeHistoryRegistry': {}, './runtimeDataSetManagement': {}
  });
  let closed = false;
  const history = { root: {}, listConversations: async input => input.after ? { items: [{ id: 'excluded' }] } : { items: [{ id: 'merged' }], next: { id: 'merged', updatedAt: 'now' } },
    readMessages: async id => id, readMessageText: async id => id, close: async () => { closed = true; } };
  const reader = api.residualHistory(history, { excluded: [{ conversationId: 'excluded' }] });
  assert.deepEqual((await reader.listConversations()).items.map(item => item.id), ['excluded']);
  assert.throws(() => reader.readMessages('merged'), /不在未合并清单/);
  await reader.close();
  assert.equal(closed, true);
});

test('外来残留恢复身份后以当前来源 id 重新入队，并只重试这一份', async () => {
  const previousId = 'foreign:copied:aaaaaaaaaaaaaaaa';
  const currentId = 'foreign:copied:bbbbbbbbbbbbbbbb';
  const record = { id: previousId, sourceKind: 'copied', location: { kind: 'copied', containerPath: '/fixture/copied',
    containerName: 'copied', dataRootRelativePath: '.limcode-runtime/active' }, code: 'identity-unreadable', message: '身份不可读', checkedAt: 'now' };
  const queued = [], retried = [];
  const api = load('vscode/commands/runtimeHistoryResiduals.ts', {
    vscode: { window: { showQuickPick: async items => items.find(item => item.action === 'retry') ?? items[0] } },
    '../../backend/capabilities/vscodeStorage/globalStatus': { resolveDataRootUri: () => '/fixture' },
    '../../backend/capabilities/vscodeStorage/paths': { createVscodeStoragePaths: () => ({ globalStoragePath: '/fixture' }) },
    '../../backend/reliableKernel/vscodeRootAuthority': {}, '../../backend/reliableKernel/runtimeDataSetHistory': {},
    '../../backend/reliableKernel/runtimeForeignHistory': { isForeignRuntimeHistoryId: id => id.startsWith('foreign:'),
      readRuntimeHistoryResidualSize: async () => undefined, locateForeignRuntimeRoot: async () => ({ id: currentId,
        recorded: { dataSetId: 'restored-data', rootInstanceId: 'restored-root' } }) },
    '../../backend/reliableKernel/runtimeHistoryRegistry': { reconcileRuntimeResetBackups: async () => {},
      readRuntimeHistoryResidual: async () => new Map([[previousId, record]]),
      requeueRuntimeHistoryResidual: async (_paths, oldId, pending) => queued.push({ oldId, pending }) },
    './runtimeDataSetManagement': {}
  });
  await api.manageRuntimeHistoryResiduals({}, async id => retried.push(id));
  assert.equal(queued[0].oldId, previousId);
  assert.equal(queued[0].pending.id, currentId);
  assert.equal(queued[0].pending.identity.dataSetId, 'restored-data');
  assert.deepEqual(retried, [currentId]);
});

function upgradeNotificationFixture() {
  const rows = [{ conversation_id: 'bad', context_root_id: 'root', provenance_revision: 0n }];
  const warnings = [], progress = [], attempts = [], explicit = [];
  let fail = true;
  const api = load('backend/application/reliableKernel/contextHandleUpgradeNotification.ts', {
    vscode: { ProgressLocation: { Notification: 1 }, window: {
      withProgress: async (options, run) => {
        progress.push(options);
        return run({ report() {} }, { isCancellationRequested: false, onCancellationRequested: () => ({ dispose() {} }) });
      },
      showWarningMessage: (text, ...actions) => new Promise(resolve => warnings.push({ text, actions, resolve }))
    } },
    '../../reliableKernel/conversationContextHandleState': {
      readConversationContextHandleStateRow: async (_, id) => ({ state: rows.some(row => row.conversation_id === id) ? 'pending' : 'ready' })
    },
    '../../reliableKernel/conversationContextHandleUpgrade': {
      listPendingContextHandleUpgrades: async () => rows.map(row => ({ ...row })),
      upgradePendingConversationContextHandles: async (_, __, options) => {
        options.signal.throwIfAborted();
        const selected = rows.filter(row => !options.skipConversationIds.has(row.conversation_id));
        attempts.push(selected.map(row => row.conversation_id));
        for (const row of selected) if (!fail || row.conversation_id !== 'bad') rows.splice(rows.indexOf(row), 1);
        return selected.filter(row => fail && row.conversation_id === 'bad').map(row => ({
          conversationId: row.conversation_id, contextRootId: row.context_root_id,
          provenanceRevision: String(row.provenance_revision), error: new Error('broken compression')
        }));
      },
      upgradeConversationContextHandles: async (_, __, id, options) => {
        options.signal.throwIfAborted(); explicit.push(id);
        if (fail) throw new Error('explicit failure');
        const index = rows.findIndex(row => row.conversation_id === id);
        if (index >= 0) rows.splice(index, 1);
      }
    }
  });
  return { rows, warnings, progress, attempts, explicit, recover() { fail = false; }, application: { database: {}, contentStore: {} }, ...api };
}

test('引用目录失败通知在同一运行时去重，新会话继续升级，明确重试仍可执行', async () => {
  const f = upgradeNotificationFixture();
  const upgrade = () => f.upgradeContextHandlesWithProgress(f.application);
  await Promise.all([upgrade(), upgrade()]);
  assert.equal(f.progress.length, 1);
  assert.equal(f.warnings.length, 1);
  assert.deepEqual(f.warnings[0].actions, ['重试升级']);
  await upgrade();
  assert.equal(f.progress.length, 1, '重复事件不再弹出同一失败进度');
  f.rows.push({ conversation_id: 'healthy', context_root_id: 'new-root', provenance_revision: 0n });
  await upgrade();
  assert.deepEqual(f.attempts[1], ['healthy']);
  assert.equal(f.warnings.length, 1);
  f.recover();
  f.warnings[0].resolve('重试升级');
  await new Promise(resolve => setImmediate(resolve));
  await upgrade();
  assert.equal(f.rows.length, 0);
  assert.equal(f.progress.length, 3);
});

test('失败目录的根或来源代数变化后可以重新升级，明确单会话升级不被屏蔽', async () => {
  const f = upgradeNotificationFixture();
  await f.upgradeContextHandlesWithProgress(f.application);
  f.rows[0].provenance_revision = 1n;
  await f.upgradeContextHandlesWithProgress(f.application);
  f.rows[0].context_root_id = 'changed-root';
  await f.upgradeContextHandlesWithProgress(f.application);
  assert.equal(f.attempts.length, 3);
  await assert.rejects(f.upgradeContextHandlesWithProgress(f.application, undefined, 'bad'), /explicit failure/);
  assert.deepEqual(f.explicit, ['bad']);
  f.recover();
  await f.upgradeContextHandlesWithProgress(f.application, undefined, 'bad');
  assert.equal(f.rows.length, 0);
});

test('取消引用目录升级不记为失败，后续仍能继续', async () => {
  const f = upgradeNotificationFixture();
  const controller = new AbortController(); controller.abort();
  await assert.rejects(f.upgradeContextHandlesWithProgress(f.application, controller.signal), { name: 'AbortError' });
  assert.equal(f.warnings.length, 0);
  await f.upgradeContextHandlesWithProgress(f.application);
  assert.equal(f.attempts.length, 1);
  assert.equal(f.warnings.length, 1);
});

test('待合并通知按钮调用既有合并命令，关闭或过期通知不执行', async () => {
  const relative = 'vscode/commands/runtimeDataSetManagement.ts';
  const parsed = ts.createSourceFile(relative, fs.readFileSync(path.resolve(__dirname, '../..', relative), 'utf8'), ts.ScriptTarget.Latest);
  const dependencies = Object.fromEntries(parsed.statements.filter(ts.isImportDeclaration).map(item => [item.moduleSpecifier.text, {}]));
  const notices = [], commands = [], saved = new Map(); let current = true;
  Object.assign(dependencies, {
    vscode: { window: { showInformationMessage: (text, ...actions) => new Promise(resolve => notices.push({ text, actions, resolve })) },
      commands: { executeCommand: async command => commands.push(command) } },
    '../../shared/extensionIdentity': { EXTENSION_COMMAND_IDS: { mergeAllRuntimeHistory: 'existing-merge-command' } },
    '../../backend/capabilities/vscodeStorage/globalStatus': { loadCommittedGlobalStatus: async () => ({}), resolveDataRootUri: () => '/fixture' },
    '../../backend/capabilities/vscodeStorage/paths': { createVscodeStoragePaths: () => ({ globalStoragePath: '/fixture' }) },
    '../runtimeDataSetUpgradeLifetime': { canStartRuntimeDataSetUpgrade: () => true, runRuntimeDataSetUpgrade: async (_, run) => run() },
    '../../backend/reliableKernel/runtimeHistoryConvergence': { registerRuntimeHistoryConvergence: async () => 0 },
    '../../backend/reliableKernel/runtimeDataSetMerge': { RUNTIME_DATA_SET_MERGE_AWAITING_EXCLUSIVE: 'awaiting-exclusive',
      mergeHistoricalDataSetsOnline: async () => ({ merged: [], failures: [], blocked: [], stopped: false,
        deferred: [{ candidateId: 'old', code: 'awaiting-exclusive', message: 'waiting' }] }) }
  });
  const api = load(relative, dependencies);
  const context = { globalState: { get: (key, fallback) => saved.get(key) ?? fallback, update: async (key, value) => saved.set(key, value) } };
  const host = { product: { application: { database: {} } } };
  for (const action of ['立即合并全部', undefined, '立即合并全部']) {
    await api.mergeHistoricalDataSetsInBackground(context, host, () => current);
    const notice = notices.at(-1);
    assert.deepEqual(notice.actions, ['立即合并全部']);
    if (notices.length === 3) current = false;
    notice.resolve(action);
    await new Promise(resolve => setImmediate(resolve));
  }
  assert.deepEqual(commands, ['existing-merge-command']);
});
