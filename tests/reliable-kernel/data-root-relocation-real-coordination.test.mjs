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
const { RuntimeWriteGate } = load('backend/application/reliableKernel/runtimeWriteGate.js');
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
    // The Facade's write gate (its entry refusal is real); the ProductRuntime's freeze of its claim
    // probe is its own concern and only recorded here.
    writeGate: new RuntimeWriteGate(),
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
      // What the user gets for a write in this window while the operation closes its Runtime.
      if (this.writeGate.frozen) {
        this.writeRefusalWhenClosed = await this.renameConversationTitle('conversation_current_1', '改个名字')
          .then(() => undefined, (error) => error.message);
      }
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
  // extension.ts deactivate: leaving first, the Runtime (its liveness record) closes, then the registration goes.
  const deactivate = async () => {
    await participant.dispose();
    await fs.rm(liveness, { force: true });
    await participant.unregister();
  };
  const peer = {
    reloads: 0,
    close: deactivate
  };
  const participant = startExclusiveMaintenanceParticipant(binding.paths, hostBootId, {
    busyReason: async () => undefined,
    confirm: async () => true,
    release: async () => {
      peer.reloads += 1;
      await deactivate();
    }
  }, { pollMs: 20 });
  await participant.checkNow();
  t.after(deactivate);
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

const NOW_ISO = new Date('2026-09-27T00:00:00.000Z').toISOString();
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
  assert.equal(first.window.writeRefusalWhenClosed, '正在迁移数据目录，完成后再操作。', '冻结期间本窗口的写命令在入口被拒绝并说明原因');
  assert.ok(ui.calls.some(([kind, message]) => kind === 'warning' && message.endsWith('正在迁移数据目录，完成后再操作。')));
  assert.equal(first.window.frozen, 0, '锁内轮次结束后解冻');
  assert.equal(first.window.writeGate.frozen, false, '写命令也随之解冻');
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
  assert.equal(second.window.writeRefusalWhenClosed, '正在切换回旧数据目录，完成后再操作。', '提示按操作说明替换');
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
  // A staging record is undone without an 'undoing' mark first (the undo only deletes and renames back).
  assert.equal(JSON.parse(await fs.readFile(markerFile, 'utf8')).state, 'staging');
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

/** An existing LimCode directory copied here from elsewhere (its RootBindings name another path). */
async function copiedHome(fixture) {
  const target = path.join(fixture.base, 'copied-home');
  const elsewhere = path.join(fixture.base, 'elsewhere');
  await createLimCodeTarget(elsewhere);
  await fs.cp(elsewhere, target, { recursive: true });
  await fs.rm(elsewhere, { recursive: true, force: true });
  return { target, before: await treeSnapshot(target) };
}

const asidesIn = async (directory) => (await fs.readdir(directory)).filter((name) => name.includes('.limcode-copied-'));

test('reloc3 问题 2（R3-A）拷来的目标：完成阶段失败、撤销最后把拷贝改回原名时 EPERM：不算撤销完，保留进行中记录并写明拷贝在哪；下次启动改回', async (t) => {
  const fixture = await createFixture(t, { withAlpha: false });
  const { target, before } = await copiedHome(fixture);
  const storage = path.join(fixture.base, 'vscode-global-storage');
  await fs.mkdir(storage);
  const vscodeContext = context(storage);
  await globalStatus.saveGlobalStatus(vscodeContext, fixture.root, '');
  const first = await openWindow(t, fixture.root);
  ui.calls.length = 0;
  ui.picked = target;
  const fsp = require('node:fs/promises');
  const rename = fsp.rename;
  let selectionFailures = 0;
  fsp.rename = async function (from, to, ...rest) {
    // Completion fails writing the new root's selection file; putting the copy back is refused (a Windows sharing violation).
    if (path.basename(String(to)) === '.limcode-runtime-selection.json' && path.dirname(String(to)) === target && selectionFailures === 0) {
      selectionFailures += 1;
      throw Object.assign(new Error('EIO: injected failure writing the selection'), { code: 'EIO' });
    }
    if (String(from).includes('.limcode-copied-') && path.resolve(String(to)) === target) {
      throw Object.assign(new Error('EPERM: operation not permitted, rename'), { code: 'EPERM' });
    }
    return rename.call(this, from, to, ...rest);
  };
  try {
    await commands.relocateDataRoot(vscodeContext, first.startup, { clientId: 'client-1' });
  } finally { fsp.rename = rename; }
  const trace = () => JSON.stringify(ui.calls, null, 1);
  const [aside] = await asidesIn(fixture.base);
  assert.ok(aside, '前提：拷贝留在旁边');
  const status = await globalStatus.loadCommittedGlobalStatus(vscodeContext);
  assert.equal(status.pendingRelocation?.targetRootPath, target, `拷贝没改回原名：进行中记录保留给下次启动：${trace()}`);
  const error = ui.calls.find(([kind]) => kind === 'error');
  assert.match(error?.[2] ?? '', /没能全部撤销/);
  assert.ok((error?.[2] ?? '').includes(path.join(fixture.base, aside)), '提示写明拷贝在哪');

  // The next startup (a new process) puts the copy back.
  const statusFile = path.join(storage, globalStatus.LIMCODE_GLOBAL_STATUS_FILE);
  const saved = JSON.parse(await fs.readFile(statusFile, 'utf8'));
  saved.pendingRelocation.processId = spawnSync(process.execPath, ['-e', '']).pid;
  delete saved.pendingRelocation.processStartIdentity;
  await fs.writeFile(statusFile, `${JSON.stringify(saved, null, 2)}\n`);
  const restarted = context(storage);
  assert.equal(await commands.beforeDataRootOpen(restarted), undefined);
  assert.ok(!(await globalStatus.loadCommittedGlobalStatus(restarted)).pendingRelocation);
  assert.deepEqual(await asidesIn(fixture.base), []);
  const after = await treeSnapshot(target);
  for (const [file, digest] of Object.entries(before)) assert.equal(after[file], digest, `改回原样：${file}`);
});

test('reloc3 问题 2（R3-A2）拷来的目标：改名挪开之后目录 fsync 失败：准备阶段把拷贝改回原名，如实提示已撤销、清除进行中记录', async (t) => {
  const fixture = await createFixture(t, { withAlpha: false });
  const { target, before } = await copiedHome(fixture);
  const storage = path.join(fixture.base, 'vscode-global-storage');
  await fs.mkdir(storage);
  const vscodeContext = context(storage);
  await globalStatus.saveGlobalStatus(vscodeContext, fixture.root, '');
  const first = await openWindow(t, fixture.root);
  ui.calls.length = 0;
  ui.picked = target;
  const durable = require(path.join(compiled, 'backend/capabilities/filesystem/durableDirectorySync.js'));
  const sync = durable.syncDirectoryDurably;
  let injected = 0;
  durable.syncDirectoryDurably = async function (directory, ...rest) {
    if (injected === 0 && (await asidesIn(fixture.base)).length > 0 && path.resolve(directory) === fixture.base) {
      injected += 1;
      throw Object.assign(new Error('EIO: injected directory fsync failure'), { code: 'EIO' });
    }
    return sync.call(this, directory, ...rest);
  };
  try {
    await commands.relocateDataRoot(vscodeContext, first.startup, { clientId: 'client-1' });
  } finally { durable.syncDirectoryDurably = sync; }
  assert.equal(injected, 1, '前提：注入生效');
  assert.deepEqual(await asidesIn(fixture.base), [], '拷贝已改回原名');
  assert.ok(!(await globalStatus.loadCommittedGlobalStatus(vscodeContext)).pendingRelocation);
  assert.match(ui.calls.filter(([kind]) => kind === 'prompt').at(-1)?.[2] ?? '', /本次做的改动已撤销/);
  const after = await treeSnapshot(target);
  for (const [file, digest] of Object.entries(before)) assert.equal(after[file], digest, `原样：${file}`);
  assert.equal(first.window.closed, false, '准备阶段失败：本窗口的运行时照常打开');
});

test('reloc3 #6 准备阶段撤销没做完、进行中记录属于本窗口：同一窗口再点迁移时不说“另一个窗口在迁移”，而是先把本窗口上次的撤销做完再迁移', async (t) => {
  const fixture = await createFixture(t, { withAlpha: false });
  const { target } = await copiedHome(fixture);
  const storage = path.join(fixture.base, 'vscode-global-storage');
  await fs.mkdir(storage);
  const vscodeContext = context(storage);
  await globalStatus.saveGlobalStatus(vscodeContext, fixture.root, '');
  const window = await openWindow(t, fixture.root);
  ui.calls.length = 0;
  ui.picked = target;
  const merge = require(path.join(compiled, 'backend/reliableKernel/runtimeDataSetMerge.js'));
  const precopy = merge.precopyRuntimeDataSetCas;
  const fsp = require('node:fs/promises');
  const rename = fsp.rename;
  let failing = true;
  merge.precopyRuntimeDataSetCas = async function (...args) {
    if (failing) throw Object.assign(new Error('注入：预复制时磁盘已满'), { code: 'ENOSPC' });
    return precopy.apply(this, args);
  };
  fsp.rename = async function (from, to, ...rest) {
    if (failing && String(from).includes('.limcode-copied-') && path.resolve(String(to)) === target) {
      throw Object.assign(new Error('EPERM: operation not permitted, rename'), { code: 'EPERM' });
    }
    return rename.call(this, from, to, ...rest);
  };
  t.after(() => { merge.precopyRuntimeDataSetCas = precopy; fsp.rename = rename; });
  await commands.relocateDataRoot(vscodeContext, window.startup, { clientId: 'client-1' });
  const trace = () => JSON.stringify(ui.calls, null, 1);
  assert.equal(window.window.closed, false);
  assert.equal((await globalStatus.loadCommittedGlobalStatus(vscodeContext)).pendingRelocation?.processId, process.pid, `前提：本窗口的记录留着：${trace()}`);
  assert.equal((await asidesIn(fixture.base)).length, 1);
  failing = false;
  ui.calls.length = 0;
  await commands.relocateDataRoot(vscodeContext, window.startup, { clientId: 'client-1' });
  assert.ok(!JSON.stringify(ui.calls).includes('另一个 LimCode 窗口正在迁移'), trace());
  assert.deepEqual(failures(), [], `这次迁移成功：${trace()}`);
  assert.equal((await globalStatus.loadCommittedGlobalStatus(vscodeContext)).dataRootPath, target);
  assert.deepEqual(conversationIds((await selectedDataSet(target)).runtimeDataRootPath), ['conversation_current_1', 'conversation_current_2']);
});

test('reloc3 F1/问题 1 真实的 Facade.open：新目录里有发起进程还在的迁移时拒绝打开（reason relocating）；撤销之后打开时为旧版本设置的自定义目录记下身份', async (t) => {
  const fixture = await createFixture(t, { withAlpha: false });
  const target = path.join(fixture.base, 'existing');
  await createLimCodeTarget(target);
  const storage = path.join(fixture.base, 'vscode-global-storage');
  await fs.mkdir(storage);
  const vscodeContext = context(storage);
  await globalStatus.saveGlobalStatus(vscodeContext, target, '');
  const plan = await planWithRuntime(fixture, target);
  const source = await kernel.RuntimeDatabase.open(fixture.current.authority, { hostBootId: `window-${randomUUID()}` });
  let staged;
  try { staged = await relocation.stageDataRootRelocation(plan, source); } finally { await source.close(); }
  const open = () => Facade.open(vscodeContext).then(async (facade) => { await facade.dispose(); return undefined; }, (error) => error);
  const refused = await open();
  assert.equal(refused?.reason, 'relocating', `拒绝打开：${refused?.message}`);
  assert.ok(!(await globalStatus.loadCommittedGlobalStatus(vscodeContext)).dataRootId, '拒绝时什么都不记');
  await relocation.abandonStagedDataRootRelocation(staged);
  // The rest of opening needs a real VS Code; the identity is recorded before that, inside the admission.
  const opened = await open();
  assert.notEqual(opened?.reason, 'relocating');
  const recorded = (await globalStatus.loadCommittedGlobalStatus(vscodeContext)).dataRootId;
  assert.ok(recorded, `打开时记下了身份：${opened?.message}`);
  assert.equal(recorded, await relocation.readDataRootIdentity(target));
});

test('盲审 #9：真实的 Facade.open 拿到锁时就告诉扩展等待已经结束（onRuntimeWaitOver），不等打开的其余部分', async (t) => {
  const fixture = await createFixture(t, { withAlpha: false });
  const storage = path.join(fixture.base, 'vscode-global-storage');
  await fs.mkdir(storage);
  const vscodeContext = context(storage);
  await globalStatus.saveGlobalStatus(vscodeContext, fixture.root, '');
  const over = [];
  // The rest of opening needs a real VS Code; the admission (and the scope's maintenance claim) come first.
  await Facade.open(vscodeContext, { onRuntimeWait() {}, onRuntimeWaitOver: () => over.push('over') })
    .then(async (facade) => { await facade.dispose(); }, () => undefined);
  assert.ok(over.length >= 1, 'told once the admission was taken');
});

test('reloc3 G1 globalStatus 的进行中记录按比较后写入：已有别的进行中迁移时拒绝写入；清除只清自己的', async (t) => {
  const fixture = await createFixture(t, { withAlpha: false });
  const storage = path.join(fixture.base, 'vscode-global-storage');
  await fs.mkdir(storage);
  const vscodeContext = context(storage);
  await globalStatus.saveGlobalStatus(vscodeContext, fixture.root, '');
  const pending = (id) => ({ relocationId: id, sourceRootPath: fixture.root, targetRootPath: path.join(fixture.base, 'x'), startedAt: NOW_ISO, processId: process.pid });
  const first = randomUUID();
  const second = randomUUID();
  await globalStatus.updateGlobalStatusDataRoot(vscodeContext, { pendingRelocation: pending(first), expectedPendingRelocationId: null });
  await assert.rejects(globalStatus.updateGlobalStatusDataRoot(vscodeContext, { pendingRelocation: pending(second), expectedPendingRelocationId: null }),
    { code: 'global-status-pending-relocation-conflict' });
  await globalStatus.updateGlobalStatusDataRoot(vscodeContext, { pendingRelocation: null, expectedPendingRelocationId: second });
  assert.equal((await globalStatus.loadCommittedGlobalStatus(vscodeContext)).pendingRelocation?.relocationId, first, '别人的记录不被清掉');
  await globalStatus.updateGlobalStatusDataRoot(vscodeContext, { pendingRelocation: null, expectedPendingRelocationId: first });
  assert.ok(!(await globalStatus.loadCommittedGlobalStatus(vscodeContext)).pendingRelocation);
});

test('最后一轮 #5 globalStatus 记下历次离开的数据目录（最近的在前，最多 10 个）：切走时记下，切回时当前目录不算，外来发现确认空了的与删掉的旧目录去掉；格式不对报损坏', async (t) => {
  const fixture = await createFixture(t, { withAlpha: false });
  const storage = path.join(fixture.base, 'vscode-global-storage');
  await fs.mkdir(storage);
  const vscodeContext = context(storage);
  const [a, b, c] = ['a-home', 'b-home', 'c-home'].map((name) => path.join(fixture.base, name));
  await globalStatus.saveGlobalStatus(vscodeContext, a, '');
  const move = (from, to) => globalStatus.updateGlobalStatusDataRoot(vscodeContext, {
    dataRootPath: to, lastMigration: { fromPath: from, toPath: to, migratedAt: NOW_ISO, relocationId: randomUUID() }
  });
  const roots = async () => (await globalStatus.loadCommittedGlobalStatus(vscodeContext)).previousDataRoots;
  await move(a, b);
  await move(b, c);
  assert.deepEqual(await roots(), [b, a], 'A→B→C：A 和 B 都记着（不只最近一次的来源）');
  await move(c, a);
  assert.deepEqual(await roots(), [c, b], '回到 A：当前目录不算旧目录');
  await globalStatus.updateGlobalStatusDataRoot(vscodeContext, { forgetPreviousDataRoots: [b] });
  assert.deepEqual(await roots(), [c]);
  await globalStatus.updateGlobalStatusDataRoot(vscodeContext, { lastMigration: null });
  assert.equal(await roots(), undefined, '旧目录已删除（lastMigration 清除）：它也不再记');
  let current = a;
  for (let index = 0; index < 12; index += 1) {
    const next = path.join(fixture.base, `d${index}`);
    await move(current, next);
    current = next;
  }
  const many = await roots();
  assert.equal(many.length, 10, '最多 10 个');
  assert.deepEqual([many[0], many[9]], [path.join(fixture.base, 'd10'), path.join(fixture.base, 'd1')]);
  const statusFile = path.join(storage, globalStatus.LIMCODE_GLOBAL_STATUS_FILE);
  const saved = JSON.parse(await fs.readFile(statusFile, 'utf8'));
  await fs.writeFile(statusFile, JSON.stringify({ ...saved, previousDataRoots: ['relative/limcode'] }));
  await assert.rejects(globalStatus.loadCommittedGlobalStatus(context(storage)), /全局状态旧数据目录列表损坏/);
});

test('reloc3 F4 冻结的窗口只认领自己已持有的对话，解冻后照常按资格认领', async () => {
  const productModule = load('backend/application/reliableKernel/VscodeReliableKernelProductRuntime.js');
  const product = Object.assign(Object.create(productModule.VscodeReliableKernelProductRuntime.prototype), { executionGate: { frozen: 0 } });
  const probe = productModule.freezableClaimProbe(product.executionGate, { owns: (id) => id === 'owned' }, async (id) => id !== 'ineligible');
  assert.deepEqual([await probe('new'), await probe('owned'), await probe('ineligible')], [true, true, false]);
  const thaw = product.freezeNewExecution();
  assert.deepEqual([await probe('new'), await probe('owned'), await probe('ineligible')], [false, true, false]);
  thaw();
  thaw();
  assert.deepEqual([await probe('new'), await probe('owned')], [true, true], '解冻可以重复调用');
});

test('盲审 1（exp2b）指针已切到新目录之后，释放旧目录的锁失败（EIO）：迁移按已完成处理，不撤销；如实提示“迁移已完成，收尾时出错”，新目录照常打开并收尾', async (t) => {
  const fixture = await createFixture(t, { withAlpha: false });
  const target = path.join(fixture.base, 'new-home');
  const storage = path.join(fixture.base, 'vscode-global-storage');
  await fs.mkdir(storage);
  const vscodeContext = context(storage);
  await globalStatus.saveGlobalStatus(vscodeContext, fixture.root, '');
  const first = await openWindow(t, fixture.root);
  // The real locks: the operation under them (relocation + pointer switch) succeeds, then releasing
  // the old directory's claim fails (e.g. the old directory's drive went away just then).
  const realLocks = Facade.prototype.withDataRootLocks;
  first.window.withDataRootLocks = async function (body) {
    await realLocks.call(this, body);
    throw Object.assign(new Error("EIO: i/o error, rename '.limcode-runtime.runtime-maintenance'"), { code: 'EIO' });
  };
  ui.calls.length = 0;
  ui.picked = target;
  await commands.relocateDataRoot(vscodeContext, first.startup, { clientId: 'client-1' });
  const status = await globalStatus.loadCommittedGlobalStatus(vscodeContext);
  assert.equal(status.dataRootPath, target, '指针切换到新目录');
  assert.equal(status.pendingRelocation, undefined);
  await relocation.assertDataRootAvailable(target, status.dataRootId);
  assert.deepEqual(conversationIds((await selectedDataSet(target)).runtimeDataRootPath), ['conversation_current_1', 'conversation_current_2']);
  const told = ui.calls.find(([kind, title]) => kind === 'error' && title === '数据目录迁移已完成');
  assert.match(told?.[2] ?? '', /迁移已完成，收尾时出错：.*EIO/);
  assert.ok(!ui.calls.some(([kind, , detail]) => kind === 'error' && /数据目录没有切换/.test(detail ?? '')), '不说与事实相反的话');
  assert.equal(reloads(), 1);
  // The reloaded window opens the new directory: its own relocation is confirmed and finalized there.
  await commands.afterDataRootOpened(vscodeContext, target);
  assert.equal(JSON.parse(await fs.readFile(path.join(target, relocation.DATA_ROOT_RELOCATION_MARKER_FILE), 'utf8')).state, 'finalized');
});

test('盲审 7（exp8）进行中记录指向一个再也接不上的位置（记录里有目标锚点）：给出“放弃这次迁移的记录”，确认后照常选择新文件夹迁移', async (t) => {
  const fixture = await createFixture(t, { withAlpha: false });
  const storage = path.join(fixture.base, 'vscode-global-storage');
  await fs.mkdir(storage);
  const vscodeContext = context(storage);
  await globalStatus.saveGlobalStatus(vscodeContext, fixture.root, '');
  const lostTarget = path.join(fixture.base, 'lost-drive', 'LimCode');
  await globalStatus.updateGlobalStatusDataRoot(vscodeContext, {
    pendingRelocation: {
      relocationId: randomUUID(), sourceRootPath: fixture.root, targetRootPath: lostTarget, startedAt: NOW_ISO,
      processId: spawnSync(process.execPath, ['-e', '']).pid, targetAnchor: { parent: '1:1' }
    },
    expectedPendingRelocationId: null
  });
  const first = await openWindow(t, fixture.root);
  ui.calls.length = 0;
  ui.picked = path.join(fixture.base, 'new-home');
  await commands.relocateDataRoot(vscodeContext, first.startup, { clientId: 'client-1' });
  const offered = ui.calls.find(([kind, title]) => kind === 'prompt' && title === '上次的迁移还没有撤销完');
  assert.match(offered?.[2] ?? '', /现在看不到/);
  assert.match(offered[2], /放弃之后不会再尝试撤销：旧目录没有改动/);
  assert.ok(ui.calls.some(([kind]) => kind === 'open-dialog'), '放弃记录之后照常选择新文件夹');
  const status = await globalStatus.loadCommittedGlobalStatus(vscodeContext);
  assert.equal(status.dataRootPath, ui.picked, '迁移照常完成');
  assert.equal(status.pendingRelocation, undefined);
});
