const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const test = require('node:test');
const ts = require('typescript');

function fixture({ picks = [], confirmation, application } = {}) {
  const current = { id: 'default', dataSetId: 'current', selected: true, runtimeDataRootPath: '/fixture/current' };
  const old = { id: 'workspace:old', dataSetId: 'old', selected: false, runtimeDataRootPath: '/fixture/old' };
  const calls = [];
  class SelectionRequired extends Error { constructor() { super('select'); this.candidates = [current, old]; } }
  const vscode = {
    window: {
      async showQuickPick(items) { const pick = picks.shift(); calls.push(['pick', items]); return typeof pick === 'function' ? pick(items) : pick === undefined ? undefined : items[pick]; },
      async showWarningMessage() { return confirmation; },
      async showInformationMessage(message) { calls.push(['info', message]); },
      async showErrorMessage(message) { calls.push(['error', message]); },
      async withProgress(_options, action) { return action(); },
      async showTextDocument(document) { calls.push(['document', document]); }
    },
    workspace: {
      registerTextDocumentContentProvider(_scheme, provider) { this.provider = provider; return { dispose() {} }; },
      onDidCloseTextDocument() { return { dispose() {} }; },
      async openTextDocument(uri) { return this.provider.provideTextDocumentContent(uri); }
    },
    Uri: { from(parts) { return { toString: () => JSON.stringify(parts) }; } },
    ProgressLocation: { Notification: 1 },
    commands: { async executeCommand(command) { calls.push(['command', command]); } }
  };
  const dependencies = {
    vscode,
    '../../backend/capabilities/vscodeStorage/globalStatus': { loadCommittedGlobalStatus: async () => {}, resolveDataRootUri: () => '/fixture' },
    '../../backend/capabilities/vscodeStorage/paths': { createVscodeStoragePaths: () => ({ globalStoragePath: '/fixture' }) },
    '../../backend/reliableKernel/vscodeRootAuthority': {
      listVscodeRuntimeDataSets: async () => [current, old],
      selectVscodeRuntimeDataSet: async (_paths, id) => calls.push(['select', id]),
      VscodeRuntimeDataSetSelectionRequiredError: SelectionRequired
    },
    '../../backend/reliableKernel/runtimeDataSetHistory': {
      openRuntimeDataSetHistory: async (_paths, id) => {
        calls.push(['history', id]);
        return {
          listConversations: async () => ({ items: [{ id: 'conversation', title: 'Original history', updatedAt: '2026-01-01' }] }),
          readMessages: async () => ({ items: [{ id: 'message', role: 'user', text: 'preserved text', createdAt: '2026-01-01' }] }),
          close: async () => calls.push(['close'])
        };
      }
    },
    '../../backend/reliableKernel/runtimeStorageInspection': {
      deleteUnselectedRuntimeDataSet: async (_paths, id, expected) => calls.push(['delete', id, expected])
    },
    '../../shared/extensionIdentity': { EXTENSION_COMMAND_IDS: { resetDevelopmentData: 'reset' } }
  };
  const filename = path.resolve(__dirname, '../../vscode/commands/runtimeDataSetManagement.ts');
  const module = { exports: {} };
  vm.runInNewContext(ts.transpileModule(fs.readFileSync(filename, 'utf8'), {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS }
  }).outputText, { module, exports: module.exports, require: name => dependencies[name] ?? require(name) });
  return { ...module.exports, context: { subscriptions: [] }, startup: { current: () => application }, calls, SelectionRequired };
}

test('startup asks once after selection-required, selects exact candidate and retries open', async () => {
  const f = fixture({ picks: [1] }); let opens = 0;
  assert.equal(await f.openWithRuntimeDataSetSelection(f.context, async () => {
    if (++opens === 1) throw new f.SelectionRequired();
    return 'ready';
  }), 'ready');
  assert.deepEqual(f.calls.filter(call => call[0] === 'select'), [['select', 'workspace:old']]);
  assert.equal(opens, 2);
});

test('cancelling startup picker never silently chooses a library', async () => {
  const f = fixture();
  await assert.rejects(f.openWithRuntimeDataSetSelection(f.context, async () => { throw new f.SelectionRequired(); }), /尚未选择/);
  assert.equal(f.calls.some(call => call[0] === 'select'), false);
});

test('deletion only offers other histories and cancellation performs no mutation', async () => {
  const f = fixture({ picks: [3, items => { assert.equal(items.length, 1); assert.equal(items[0].candidate.id, 'workspace:old'); return items[0]; }] });
  await f.manageRuntimeDataSets(f.context, f.startup);
  assert.equal(f.calls.some(call => call[0] === 'delete'), false);
  const confirmed = fixture({ picks: [3, 0], confirmation: '永久删除' });
  await confirmed.manageRuntimeDataSets(confirmed.context, confirmed.startup);
  assert.deepEqual(confirmed.calls.filter(call => call[0] === 'delete'), [['delete', 'workspace:old', 'old']]);
});

test('read-only history is available without runtime startup and closes its snapshot on exit', async () => {
  const f = fixture({ picks: [0, 0, 0, 0, undefined] });
  await f.manageRuntimeDataSets(f.context, f.startup);
  assert.deepEqual(f.calls.filter(call => call[0] === 'history'), [['history', 'workspace:old']]);
  assert.equal(f.calls.filter(call => call[0] === 'close').length, 1);
  assert.match(f.calls.find(call => call[0] === 'document')[1], /preserved text/);
  assert.equal(f.calls.some(call => ['select', 'delete', 'command'].includes(call[0])), false);
});

test('switch uses live facade shutdown path, otherwise selects offline, then reloads', async () => {
  const live = [];
  const f = fixture({ picks: [2, 1], confirmation: '切换并重载', application: { async selectRuntimeDataSet(id) { live.push(id); } } });
  await f.manageRuntimeDataSets(f.context, f.startup);
  assert.deepEqual(live, ['workspace:old']);
  assert.equal(f.calls.some(call => call[0] === 'select'), false);
  assert.deepEqual(f.calls.filter(call => call[0] === 'command'), [['command', 'workbench.action.reloadWindow']]);
  const offline = fixture({ picks: [2, 1], confirmation: '切换并重载' });
  await offline.manageRuntimeDataSets(offline.context, offline.startup);
  assert.deepEqual(offline.calls.filter(call => ['select', 'command'].includes(call[0])), [['select', 'workspace:old'], ['command', 'workbench.action.reloadWindow']]);
});
