// 迁移数据目录与回到旧目录的单窗口全流程，协调原语不打桩: the compiled command module
// (vscode/commands/dataRootRelocation.js), its coordination layer (vscode/runtimeExclusiveMaintenance.js),
// the backend runtimeExclusiveMaintenance, the Facade's own lock and close methods, the relocation
// backend and globalStatus all run for real against LIMCODE_TEST_EXTENSION_ROOT (or dist). Only the
// VS Code UI is a mock: the folder picker returns the target, confirmations are accepted, and a
// settings-page prompt is answered through the real dataRootPrompts module.
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import fs from 'node:fs/promises';
import { createRequire } from 'node:module';
import path from 'node:path';
import test from 'node:test';
import {
  compiled, conversationIds, createFixture, kernel, planWithRuntime, relocate, RootAuthority, selectedDataSet
} from './runtime-data-root-relocation-fixture.mjs';

const require = createRequire(import.meta.url);
const Module = require('node:module');

class MockUri {
  constructor(fsPath) {
    this.scheme = 'file';
    this.fsPath = path.resolve(fsPath);
    this.path = this.fsPath.replaceAll('\\', '/');
  }
  static file(fsPath) { return new MockUri(fsPath); }
  static parse(text) { return new MockUri(text.replace(/^file:\/\//, '')); }
  static joinPath(base, ...segments) { return new MockUri(path.join(base.fsPath, ...segments)); }
  toString() { return `file://${this.path}`; }
}

const ui = { calls: [], picked: undefined };
const CONFIRMATIONS = new Set(['迁移并重载', '回到旧目录']);
const vscodeMock = {
  Uri: MockUri,
  EventEmitter: class { event = () => ({ dispose() {} }); fire() {} dispose() {} },
  ProgressLocation: { Notification: 15 },
  window: {
    state: { focused: true },
    async showOpenDialog() { ui.calls.push(['open-dialog']); return [MockUri.file(ui.picked)]; },
    async showWarningMessage(message, options, ...items) {
      ui.calls.push(['warning', message, options?.detail]);
      return items.find((item) => CONFIRMATIONS.has(item));
    },
    async showInformationMessage(message) { ui.calls.push(['info', message]); },
    async showErrorMessage(message, options) { ui.calls.push(['error', message, options?.detail]); },
    async withProgress(_options, task) {
      return task({ report() {} }, { isCancellationRequested: false, onCancellationRequested: () => ({ dispose() {} }) });
    }
  },
  commands: { async executeCommand(command) { ui.calls.push(['command', command]); } }
};
const originalLoad = Module._load;
Module._load = function load(name, parent, isMain) {
  return name === 'vscode' ? vscodeMock : originalLoad.call(this, name, parent, isMain);
};

const load = (file) => require(path.join(compiled, file));
const commands = load('vscode/commands/dataRootRelocation.js');
const globalStatus = load('backend/capabilities/vscodeStorage/globalStatus.js');
const { VscodeReliableKernelApplicationFacade: Facade } = load('backend/application/reliableKernel/VscodeReliableKernelApplicationFacade.js');
const prompts = await fs.stat(path.join(compiled, 'vscode/dataRootPrompts.js')).then(() => load('vscode/dataRootPrompts.js'), () => undefined);

/**
 * One window: a real Runtime of the directory's selected data set and the Facade's own methods
 * (hasOwnedExecution, exclusiveMaintenanceTarget, withDataRootLocks, closeRuntime, ...). Closing
 * the Runtime stands in for the Facade's dispose; the settings page accepts every prompt.
 */
async function openWindow(t, configurationRootPath) {
  const selected = await selectedDataSet(configurationRootPath);
  const database = await kernel.RuntimeDatabase.open(new RootAuthority(() => selected.runtimeDataRootPath), { hostBootId: `window-${randomUUID()}` });
  const window = Object.assign(Object.create(Facade.prototype), {
    runtimePlacement: { configurationRootPath, runtimeScopeRootPath: configurationRootPath, runtimeDataRootPath: selected.runtimeDataRootPath },
    product: { application: { database } },
    closed: false,
    requireOpen() { if (this.closed) throw new Error('Runtime closed'); },
    async dispose() {
      if (this.closed) return;
      this.closed = true;
      await database.close();
    },
    postToWebview(clientId, message) {
      const { flowId, title, actions } = message.payload;
      ui.calls.push(['prompt', title, JSON.stringify(message.payload.sections ?? [])]);
      const accept = [...actions].reverse().find((action) => action.key !== 'cancel');
      queueMicrotask(() => prompts.answerDataRootPrompt(clientId, { flowId, choice: accept?.key ?? 'cancel', include: [] }));
      return true;
    }
  });
  t.after(() => window.dispose());
  return { window, startup: { wait: async () => window, pending: () => Promise.resolve(window) } };
}

function context(storage) {
  const state = new Map();
  return {
    globalStorageUri: MockUri.file(storage),
    globalState: { get: (key) => state.get(key), update: async (key, value) => { state.set(key, value); }, keys: () => [...state.keys()] }
  };
}

const failures = () => ui.calls.filter(([kind, title]) => kind === 'error' || (kind === 'prompt' && /没有|失败|不能/.test(title)));
const reloads = () => ui.calls.filter(([kind, command]) => kind === 'command' && command === 'workbench.action.reloadWindow').length;

test('单窗口迁移数据目录再回到旧目录：真实协调原语在锁外等待、只在短轮次里拿锁，指针切到新目录再切回，每次重载一次', async (t) => {
  const fixture = await createFixture(t, { withAlpha: false });
  const target = path.join(fixture.base, 'new-home');
  const storage = path.join(fixture.base, 'vscode-global-storage');
  await fs.mkdir(storage);
  const vscodeContext = context(storage);
  await globalStatus.saveGlobalStatus(vscodeContext, fixture.root, '');

  const first = await openWindow(t, fixture.root);
  ui.calls.length = 0;
  ui.picked = target;
  await commands.relocateDataRoot(vscodeContext, first.startup, { clientId: 'client-1' });
  const trace = () => JSON.stringify(ui.calls, null, 1);
  assert.deepEqual(failures(), [], `迁移没有失败：${trace()}`);
  assert.equal((await globalStatus.loadCommittedGlobalStatus(vscodeContext)).dataRootPath, target, `指针切到新目录：${trace()}`);
  assert.equal(first.window.closed, true, '本窗口的运行时在锁内关闭');
  assert.equal(reloads(), 1);
  assert.deepEqual(conversationIds((await selectedDataSet(target)).runtimeDataRootPath), ['conversation_current_1', 'conversation_current_2']);

  // The reloaded window opens the new directory, then goes back to the old one.
  await commands.afterDataRootOpened?.(vscodeContext, target);
  const second = await openWindow(t, target);
  ui.calls.length = 0;
  await commands.returnToPreviousDataRoot(vscodeContext, second.startup, { clientId: 'client-1' });
  assert.deepEqual(failures(), [], `回到旧目录没有失败：${trace()}`);
  assert.equal((await globalStatus.loadCommittedGlobalStatus(vscodeContext)).dataRootPath, fixture.root, `指针切回旧目录：${trace()}`);
  assert.equal(second.window.closed, true);
  assert.equal(reloads(), 1);
  assert.deepEqual(conversationIds((await selectedDataSet(fixture.root)).runtimeDataRootPath), ['conversation_current_1', 'conversation_current_2']);
});

test('回到旧目录单独走一遍（迁移由后端直接完成）：真实协调原语在锁外等待，本窗口在锁内关闭运行时后切回指针', async (t) => {
  const fixture = await createFixture(t, { withAlpha: false });
  const target = path.join(fixture.base, 'new-home');
  const storage = path.join(fixture.base, 'vscode-global-storage');
  await fs.mkdir(storage);
  const vscodeContext = context(storage);
  await globalStatus.saveGlobalStatus(vscodeContext, fixture.root, '');
  const plan = await planWithRuntime(fixture, target);
  await relocate(fixture, plan, {
    publish: () => globalStatus.saveGlobalStatus(vscodeContext, target, '', { fromPath: fixture.root, toPath: target, migratedAt: new Date().toISOString() })
  });

  const window = await openWindow(t, target);
  ui.calls.length = 0;
  await commands.returnToPreviousDataRoot(vscodeContext, window.startup, { clientId: 'client-1' });
  const trace = () => JSON.stringify(ui.calls, null, 1);
  assert.deepEqual(failures(), [], `回到旧目录没有失败：${trace()}`);
  assert.equal((await globalStatus.loadCommittedGlobalStatus(vscodeContext)).dataRootPath, fixture.root, `指针切回旧目录：${trace()}`);
  assert.equal(window.window.closed, true, '本窗口的运行时在锁内关闭');
  assert.equal(reloads(), 1);
});
