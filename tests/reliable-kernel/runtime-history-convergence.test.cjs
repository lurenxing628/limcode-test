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
  }).outputText, { module, exports: module.exports, require: name => dependencies[name] ?? require(name) });
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
    './runtimeDataSetMergeLedger': { ledgerFile: async (_, section, id) => `${section}/${id}`, writeLedgerJson: async (_, section, id, value) => records.set(`${section}/${id}`, value) },
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
  assert.equal(await api.registerRuntimeHistoryConvergence({ globalStoragePath: '/fixture' }), 0);
  assert.equal(pending.has(foreign[0].id), true, 'known foreign sources are reconsidered using the merge engine file-state cache');
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
