// 迁移数据目录与回到旧目录的单窗口全流程，协调原语不打桩: the compiled command module
// (vscode/commands/dataRootRelocation.js), its coordination layer (vscode/runtimeExclusiveMaintenance.js),
// the backend runtimeExclusiveMaintenance, the Facade's own lock and close methods, the relocation
// backend and globalStatus all run for real against LIMCODE_TEST_EXTENSION_ROOT (or dist). Only the
// VS Code UI is a mock: the folder picker returns the target, confirmations are accepted, and a
// settings-page prompt is answered through the real dataRootPrompts module.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import fs from 'node:fs/promises';
import { createRequire } from 'node:module';
import path from 'node:path';
import test from 'node:test';
import {
  compiled, conversationIds, createFixture, createLimCodeTarget, databaseRows, kernel, markStagingOwnerDead, planWithRuntime, PROJECT,
  relocate, relocation, RootAuthority, selectedDataSet, treeSnapshot
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

const ui = { calls: [], picked: undefined, failReport: undefined };
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
      const report = (value) => {
        // A step of the relocation that fails once (e.g. the disk is full while copying).
        if (ui.failReport === undefined || value?.message !== ui.failReport) return;
        ui.failReport = undefined;
        throw Object.assign(new Error('ENOSPC: no space left on device, write'), { code: 'ENOSPC' });
      };
      return task({ report }, { isCancellationRequested: false, onCancellationRequested: () => ({ dispose() {} }) });
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
const { startExclusiveMaintenanceParticipant } = load('backend/reliableKernel/runtimeExclusiveMaintenance.js');
const { ownProcessStartIdentity } = load('backend/reliableKernel/runtimeClaimPrimitives.js');
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
    // The ProductRuntime's freeze (its claim probe) is its own concern; here it is only recorded.
    product: {
      application: { database },
      freezeNewExecution() { window.frozen += 1; ui.calls.push(['freeze']); return () => { window.frozen -= 1; ui.calls.push(['thaw']); }; }
    },
    frozen: 0,
    frozenWhenClosed: undefined,
    closed: false,
    requireOpen() { if (this.closed) throw new Error('Runtime closed'); },
    async dispose() {
      if (this.closed) return;
      this.frozenWhenClosed = this.frozen;
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

/**
 * Another window of the same directory, as the coordination sees it (one process holds one
 * RuntimeDatabase per root, so its Host is its liveness record): its participant confirms at once
 * and, told to go, reloads (its Host goes offline).
 */
async function openPeer(t, configurationRootPath) {
  const selected = await selectedDataSet(configurationRootPath);
  const binding = await new RootAuthority(() => selected.runtimeDataRootPath).current();
  const hostBootId = `peer-${randomUUID()}`;
  const liveness = path.join(binding.paths.dataRootPath, 'host-liveness', `${hostBootId}.json`);
  await fs.mkdir(path.dirname(liveness), { recursive: true });
  const now = new Date().toISOString();
  await fs.writeFile(liveness, JSON.stringify({
    kind: 'limcode-runtime-host-liveness', dataSetId: binding.dataSetId, rootInstanceId: binding.rootInstanceId,
    rootGeneration: binding.rootGeneration, hostBootId, livenessId: `${hostBootId}-liveness`, processId: process.pid,
    processStartIdentity: ownProcessStartIdentity(), startedAt: now, heartbeatAt: now
  }));
  const peer = {
    reloads: 0,
    async close() { await participant.dispose(); await fs.rm(liveness, { force: true }); }
  };
  const participant = startExclusiveMaintenanceParticipant(binding.paths, hostBootId, {
    busyReason: async () => undefined,
    confirm: async () => true,
    release: async () => {
      peer.reloads += 1;
      await participant.dispose();
      await fs.rm(liveness, { force: true });
    }
  }, { pollMs: 20 });
  await participant.checkNow();
  t.after(async () => {
    await participant.dispose();
    await fs.rm(liveness, { force: true });
  });
  return peer;
}

function context(storage) {
  const state = new Map();
  // This window's workspaceState: it survives the window's reloads (reuse the same context for that).
  const workspace = new Map();
  return {
    globalStorageUri: MockUri.file(storage),
    globalState: { get: (key) => state.get(key), update: async (key, value) => { state.set(key, value); }, keys: () => [...state.keys()] },
    workspaceState: {
      get: (key) => workspace.get(key),
      update: async (key, value) => { if (value === undefined) workspace.delete(key); else workspace.set(key, value); },
      keys: () => [...workspace.keys()]
    }
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
  assert.equal(first.window.frozenWhenClosed, 1, '关闭运行时时本窗口已冻结（beforeGo），不再开始新任务');
  assert.equal(first.window.frozen, 0, '锁内轮次结束后解冻');
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

test('迁移在其它窗口让出之后失败（复制时磁盘满），本窗口按流程重载：用户马上再点迁移可以立即进行；刚让出的另一个窗口去点迁移仍被冷却挡住，并写明何时可以再试', async (t) => {
  const fixture = await createFixture(t, { withAlpha: false });
  const target = path.join(fixture.base, 'new-home');
  const storage = path.join(fixture.base, 'vscode-global-storage');
  await fs.mkdir(storage);
  const vscodeContext = context(storage);
  await globalStatus.saveGlobalStatus(vscodeContext, fixture.root, '');
  const trace = () => JSON.stringify(ui.calls, null, 1);

  const first = await openWindow(t, fixture.root);
  const peer = await openPeer(t, fixture.root);
  ui.calls.length = 0;
  ui.picked = target;
  ui.failReport = '正在复制设置、全局规则和技能';
  try {
    await commands.relocateDataRoot(vscodeContext, first.startup, { clientId: 'client-1' });
  } finally { ui.failReport = undefined; }
  assert.match(ui.calls.find(([kind]) => kind === 'error')?.[2] ?? '', /ENOSPC[\s\S]*窗口将重载以重新打开原目录/, trace());
  assert.equal(peer.reloads, 1, '另一个窗口已经让出');
  assert.equal(first.window.closed, true);
  assert.equal(reloads(), 1, '本窗口按迁移流程重载');
  const status = await globalStatus.loadCommittedGlobalStatus(vscodeContext);
  assert.equal(status.dataRootPath, fixture.root);
  assert.equal(status.pendingRelocation, undefined, trace());

  // Both windows open again. The one that yielded (its own workspaceState) clicks “迁移数据目录” too;
  // it would make this window reload: held off, with when. (This window stands in as a peer here.)
  const yielded = await openWindow(t, fixture.root);
  const standIn = await openPeer(t, fixture.root);
  ui.calls.length = 0;
  await commands.relocateDataRoot(context(storage), yielded.startup, { clientId: 'client-2' });
  const refused = ui.calls.find(([kind, title]) => kind === 'prompt' && /没有进行/.test(title));
  assert.match(refused?.[2] ?? '', /暂不再次要求其它窗口重载。约 10 分钟后（\d\d:\d\d 以后）可以再试。/, trace());
  assert.equal(yielded.window.closed, false);
  assert.equal(standIn.reloads, 0);
  assert.equal(reloads(), 0);
  await standIn.close();
  await yielded.window.dispose();

  // This window reloaded (the same workspaceState): the user retries right away and it runs.
  const reopened = await openWindow(t, fixture.root);
  const peerAgain = await openPeer(t, fixture.root);
  ui.calls.length = 0;
  await commands.relocateDataRoot(vscodeContext, reopened.startup, { clientId: 'client-1' });
  assert.deepEqual(failures(), [], `重试没有失败：${trace()}`);
  assert.equal((await globalStatus.loadCommittedGlobalStatus(vscodeContext)).dataRootPath, target, trace());
  assert.equal(peerAgain.reloads, 1, '其它窗口为这一次操作再重载一次');
  assert.equal(reloads(), 1);
  assert.deepEqual(conversationIds((await selectedDataSet(target)).runtimeDataRootPath), ['conversation_current_1', 'conversation_current_2']);
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

test('#12 另一个窗口切换了数据目录（例如当前目录不可达时回到旧目录）：仍开着的窗口配置路径固定在它打开时的目录，发现指针变了就拒绝读写配置并提示重载', async (t) => {
  const fixture = await createFixture(t, { withAlpha: false });
  const storage = path.join(fixture.base, 'vscode-global-storage');
  await fs.mkdir(storage);
  const stillOpen = context(storage);
  await globalStatus.saveGlobalStatus(stillOpen, fixture.root, '');
  const { pinnedDataRootPaths } = load('backend/application/reliableKernel/VscodeReliableKernelProductRuntime.js');
  const getPaths = pinnedDataRootPaths(stillOpen, fixture.root);
  assert.equal(getPaths().globalStorageUri.fsPath, fixture.root);

  const elsewhere = path.join(fixture.base, 'elsewhere');
  await globalStatus.saveGlobalStatus(context(storage), elsewhere, '');
  await globalStatus.loadCommittedGlobalStatus(stillOpen); // the settings watcher of the open window
  assert.throws(() => getPaths(), /数据目录已在其它窗口切换到 .*elsewhere.*请重载窗口后再操作/);
});

test('迁移在合并时失败、撤销又没做完（放回设置时 EPERM）：命令层保留进行中记录并如实提示；下次启动由后端真实续撤，目标恢复原样、记录清除', async (t) => {
  const fixture = await createFixture(t, { withAlpha: false });
  const target = path.join(fixture.base, 'existing');
  // Same conversation id, different content: the merge refuses, after the settings were replaced.
  const existing = await createLimCodeTarget(target, { conversations: [{ id: 'conversation_current_1', project: PROJECT, title: 'changed elsewhere' }] });
  await fs.mkdir(path.join(target, 'settings'), { recursive: true });
  await fs.writeFile(path.join(target, 'settings', 'llm.json'), '{"activeProviderConfigId":"target"}\n');
  const settingsBefore = await treeSnapshot(path.join(target, 'settings'));
  const rowsBefore = databaseRows(existing.binding.paths.databasePath);
  const storage = path.join(fixture.base, 'vscode-global-storage');
  await fs.mkdir(storage);
  const vscodeContext = context(storage);
  await globalStatus.saveGlobalStatus(vscodeContext, fixture.root, '');

  const first = await openWindow(t, fixture.root);
  ui.calls.length = 0;
  ui.picked = target;
  // Putting a replaced settings file back fails (a Windows sharing violation), in the undo and in its retry.
  const fsp = require('node:fs/promises');
  const rename = fsp.rename;
  fsp.rename = async function (from, to, ...rest) {
    if (String(from).includes(`${path.sep}configuration${path.sep}`) && !String(to).includes(relocation.DATA_ROOT_RELOCATION_BACKUPS_DIRECTORY)) {
      throw Object.assign(new Error('EPERM: operation not permitted, rename'), { code: 'EPERM' });
    }
    return rename.call(this, from, to, ...rest);
  };
  try {
    await commands.relocateDataRoot(vscodeContext, first.startup, { clientId: 'client-1' });
  } finally { fsp.rename = rename; }
  const trace = () => JSON.stringify(ui.calls, null, 1);
  const error = ui.calls.find(([kind]) => kind === 'error');
  assert.match(error?.[2] ?? '', /没能全部撤销，下次启动 LimCode 时会再撤销一次/, trace());
  const status = await globalStatus.loadCommittedGlobalStatus(vscodeContext);
  assert.equal(status.dataRootPath, fixture.root, '指针没有切换');
  assert.equal(status.pendingRelocation?.targetRootPath, target, '进行中记录留给下次启动');
  const markerFile = path.join(target, relocation.DATA_ROOT_RELOCATION_MARKER_FILE);
  assert.equal(JSON.parse(await fs.readFile(markerFile, 'utf8')).state, 'undoing');
  assert.notDeepEqual(await treeSnapshot(path.join(target, 'settings')), settingsBefore, '前提：设置确实没放回');

  // The next startup is a new process: the one that ran the relocation has ended.
  const statusFile = path.join(storage, globalStatus.LIMCODE_GLOBAL_STATUS_FILE);
  const saved = JSON.parse(await fs.readFile(statusFile, 'utf8'));
  saved.pendingRelocation.processId = spawnSync(process.execPath, ['-e', '']).pid;
  delete saved.pendingRelocation.processStartIdentity;
  await fs.writeFile(statusFile, `${JSON.stringify(saved, null, 2)}\n`);
  await markStagingOwnerDead(target);
  const restarted = context(storage);
  ui.calls.length = 0;
  assert.equal(await commands.beforeDataRootOpen(restarted), undefined);
  assert.deepEqual(ui.calls, [], `续撤成功不提示：${trace()}`);
  assert.ok(!(await globalStatus.loadCommittedGlobalStatus(restarted)).pendingRelocation, '进行中记录已清除');
  assert.deepEqual(await treeSnapshot(path.join(target, 'settings')), settingsBefore);
  assert.deepEqual(databaseRows(existing.binding.paths.databasePath), rowsBefore);
  await assert.rejects(fs.stat(markerFile), { code: 'ENOENT' });
  await assert.rejects(fs.stat(path.join(target, relocation.DATA_ROOT_RELOCATION_BACKUPS_DIRECTORY)), { code: 'ENOENT' });
});

test('reloc2 #5：旧版本设置的自定义目录（指针没有身份）第一次正常打开时记下身份，之后同一位置换成另一份数据不再放行；外置盘没挂上时读设置只给默认值、不建目录', async (t) => {
  const fixture = await createFixture(t, { withAlpha: false });
  const storage = path.join(fixture.base, 'vscode-global-storage');
  await fs.mkdir(storage);
  const vscodeContext = context(storage);
  await globalStatus.saveGlobalStatus(vscodeContext, fixture.root, '');
  assert.ok(!(await globalStatus.loadCommittedGlobalStatus(vscodeContext)).dataRootId, '前提：指针没有记录身份');
  const { recordDataRootIdentity } = load('backend/application/reliableKernel/VscodeReliableKernelApplicationFacade.js');
  await recordDataRootIdentity(vscodeContext);
  const recorded = (await globalStatus.loadCommittedGlobalStatus(vscodeContext)).dataRootId;
  assert.equal(recorded, await relocation.readDataRootIdentity(fixture.root));
  await recordDataRootIdentity(vscodeContext);
  assert.equal((await globalStatus.loadCommittedGlobalStatus(vscodeContext)).dataRootId, recorded, '只记一次');
  const other = path.join(fixture.base, 'other-drive');
  await createLimCodeTarget(other);
  await assert.rejects(relocation.assertDataRootAvailable(other, recorded), { reason: 'mismatch' });

  const globalSettings = load('backend/capabilities/vscodeStorage/globalSettings.js');
  const unmounted = path.join(fixture.base, 'mnt', 'usb', 'LimCode', 'settings');
  const loaded = await globalSettings.loadGlobalSettingsFile(MockUri.file(unmounted), 'appearance');
  assert.ok(loaded.settings && loaded.revision);
  await assert.rejects(fs.stat(path.join(fixture.base, 'mnt')), { code: 'ENOENT' });
});
