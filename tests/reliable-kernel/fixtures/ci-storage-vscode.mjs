import fs from 'node:fs/promises';
import { createRequire } from 'node:module';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { compiled, kernel, selected } from './ci-storage-relocation.mjs';
const require = createRequire(import.meta.url);
const Module = require('node:module');

export class MockUri {
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

export const ui = { calls: [], picked: undefined, failReport: undefined };
const CONFIRMATIONS = new Set(['迁移并重载', '回到旧目录']);
const vscodeMock = {
  Uri: MockUri,
  EventEmitter: class { event = () => ({ dispose() {} }); fire() {} dispose() {} },
  ProgressLocation: { Notification: 15 },
  window: {
    state: { focused: true },
    onDidChangeActiveTextEditor: () => ({ dispose() {} }),
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
  FileType: { Unknown: 0, File: 1, Directory: 2, SymbolicLink: 64 },
  workspace: { fs: {
    createDirectory: uri => fs.mkdir(uri.fsPath, { recursive: true }),
    readFile: uri => fs.readFile(uri.fsPath),
    async writeFile(uri, bytes) { await fs.mkdir(path.dirname(uri.fsPath), { recursive: true }); await fs.writeFile(uri.fsPath, bytes); },
    async readDirectory(uri) { return (await fs.readdir(uri.fsPath, { withFileTypes: true })).map(item => [item.name, item.isDirectory() ? 2 : 1]); },
    async stat(uri) { const item = await fs.stat(uri.fsPath); return { type: item.isDirectory() ? 2 : 1, size: item.size, ctime: item.ctimeMs, mtime: item.mtimeMs }; },
    delete: uri => fs.rm(uri.fsPath, { recursive: true, force: true })
  } },
  commands: { async executeCommand(command) { ui.calls.push(['command', command]); } }
};
const originalLoad = Module._load;
Module._load = function load(name, parent, isMain) {
  return name === 'vscode' ? vscodeMock : originalLoad.call(this, name, parent, isMain);
};

const load = (file) => require(path.join(compiled, file));
export const commands = load('vscode/commands/dataRootRelocation.js');
const { startExclusiveMaintenanceParticipant } = load('backend/reliableKernel/runtimeExclusiveMaintenance.js');
const { ownProcessStartIdentity } = load('backend/reliableKernel/runtimeClaimPrimitives.js');
export const globalStatus = load('backend/capabilities/vscodeStorage/globalStatus.js');
const { VscodeReliableKernelApplicationFacade: Facade } = load('backend/application/reliableKernel/VscodeReliableKernelApplicationFacade.js');
const { RuntimeWriteGate } = load('backend/application/reliableKernel/runtimeWriteGate.js');
const prompts = await fs.stat(path.join(compiled, 'vscode/dataRootPrompts.js')).then(() => load('vscode/dataRootPrompts.js'), () => undefined);

/**
 * One window: a real Runtime of the directory's selected data set and the Facade's own methods
 * (hasOwnedExecution, exclusiveMaintenanceTarget, withDataRootLocks, closeRuntime, ...). Closing
 * the Runtime stands in for the Facade's dispose; the settings page accepts every prompt.
 */
export async function openWindow(t, configurationRootPath) {
  const current = await selected(configurationRootPath);
  const database = await kernel.RuntimeDatabase.open(new kernel.RootAuthority(() => current.runtimeDataRootPath), { hostBootId: `window-${randomUUID()}` });
  const window = Object.assign(Object.create(Facade.prototype), {
    runtimePlacement: { configurationRootPath, runtimeScopeRootPath: configurationRootPath, runtimeDataRootPath: current.runtimeDataRootPath },
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
  if (t) t.after(() => window.dispose());
  return { window, startup: { wait: async () => window, pending: () => Promise.resolve(window) } };
}

export function context(storage) {
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


export function restoreVscodeLoader() { Module._load = originalLoad; }
