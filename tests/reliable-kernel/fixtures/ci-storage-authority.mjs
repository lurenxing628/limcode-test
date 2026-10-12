import fs from 'node:fs/promises';
import path from 'node:path';
import { fork, execFile } from 'node:child_process';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import {
  compiled, kernel, kernelFile, Database, repo, NOW, openRuntime
} from './ci-storage-history.mjs';

const require = createRequire(import.meta.url);
const Module = require('node:module');
export const exclusive = kernelFile('runtimeExclusiveMaintenance.js');
export const control = kernelFile('runtimeHostControl.js');
const { ownProcessStartIdentity } = kernelFile('runtimeClaimPrimitives.js');
const CHILD = fileURLToPath(import.meta.url);
export const deferred = () => { let resolve, reject; const promise = new Promise((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; };
const conversation = id => repo('Conversation').insert({ id, title: id, status: 'active', created_at: NOW, updated_at: NOW });
export const interleavedSteps = id => [conversation(id),
  repo('Turn').insert({ id: `${id}_turn`, conversation_id: id, status: 'active', created_at: NOW, updated_at: NOW, terminal_at: null }),
  repo('CollaborationBudget').insert({ id: `${id}_budget`, origin_kind: 'turn', origin_key: `${id}_origin`, authority_turn_id: `${id}_turn`, created_at: NOW })];

// This IPC service copies the main file before it opens a SQLite writer. Copying in a process that
// holds the source's SQLite locks would release those POSIX locks when the descriptor closes.
if (process.argv[2] === '--authority-child') {
  const input = JSON.parse(process.argv[3]);
  let database, reader, participant;
  const authority = new kernel.RootAuthority(() => input.databaseRoot);
  if (input.mode === 'reader') {
    reader = new Database(input.databasePath, { readonly: true });
    reader.exec('BEGIN');
    reader.prepare('SELECT COUNT(*) FROM conversation').get();
  }
  const send = value => process.send?.(value);
  const close = async () => {
    await participant?.dispose();
    if (reader) { reader.exec('COMMIT'); reader.close(); reader = undefined; }
    await database?.close(); database = undefined;
    await participant?.unregister(); participant = undefined;
  };
  let queue = Promise.resolve();
  process.on('message', message => {
    queue = queue.then(async () => {
      let result;
      if (message.action === 'copy-main') {
        await fs.rm(`${input.copyPath}-wal`, { force: true });
        await fs.rm(`${input.copyPath}-shm`, { force: true });
        await fs.copyFile(input.databasePath, input.copyPath);
        const copy = new Database(input.copyPath, { readonly: true });
        try { result = copy.prepare('SELECT COUNT(*) FROM conversation WHERE id=?').pluck().get(message.id) === 1; }
        finally { copy.close(); }
      } else if (message.action === 'writer-open') {
        database = await kernel.RuntimeDatabase.open(authority, { hostBootId: 'ci-snapshot-writer' });
      } else if (message.action === 'commit') {
        await database.transaction(interleavedSteps(message.id)); result = message.id;
      } else if (message.action === 'writer-close') {
        await database.close(); database = undefined;
      } else if (message.action === 'window-open') {
        database = await kernel.RuntimeDatabase.open(authority, { hostBootId: input.name });
        participant = exclusive.startExclusiveMaintenanceParticipant(database.binding.paths, input.name, {
          busyReason: async () => { send({ event: 'prepare', name: input.name }); return undefined; },
          confirm: async () => { send({ event: 'confirm', name: input.name }); return true; },
          release: async () => {
            send({ event: 'release', name: input.name });
            await participant.dispose();
            await database.close(); database = undefined;
            await participant.unregister(); participant = undefined;
            send({ event: 'offline', name: input.name });
          }
        }, { pollMs: 2 });
        await participant.checkNow();
      } else if (message.action === 'stop') { await close(); }
      send({ reply: message.requestId, result });
      if (message.action === 'stop') process.disconnect();
    }).catch(error => { send({ reply: message.requestId, error: error.stack }); });
  });
  process.on('disconnect', () => { void close().then(() => process.exit(0)); });
  send({ event: 'ready', name: input.name });
} else {
  // Exported fixtures below are inert when this module is imported by node:test.
}

export function startService(dataSet, { mode = 'service', name = 'ci-peer', copyPath } = {}) {
  const env = { ...process.env }; delete env.NODE_TEST_CONTEXT;
  const child = fork(CHILD, ['--authority-child', JSON.stringify({ mode, name, copyPath,
    databaseRoot: dataSet.binding.paths.dataRootPath, databasePath: dataSet.binding.paths.databasePath })],
  { env, stdio: ['ignore', 'pipe', 'pipe', 'ipc'] });
  const ready = deferred(), exited = deferred(), replies = new Map(), events = [], observers = new Map();
  let next = 0, stderr = '';
  child.stderr.on('data', chunk => { stderr += chunk; });
  child.on('message', message => {
    if (message.reply) {
      const pending = replies.get(message.reply); replies.delete(message.reply);
      if (message.error) pending?.reject(new Error(message.error)); else pending?.resolve(message.result);
    } else {
      events.push(message);
      if (message.event === 'ready') ready.resolve();
      for (const pending of observers.get(message.event) ?? []) pending.resolve(message);
      observers.delete(message.event);
    }
  });
  child.on('error', error => { ready.reject(error); exited.reject(error); });
  child.on('exit', (code, signal) => {
    exited.resolve({ code, signal });
    const error = new Error(`authority child exited: ${code}/${signal}\n${stderr}`);
    for (const pending of replies.values()) pending.reject(error);
    replies.clear();
    if (!events.some(item => item.event === 'ready')) ready.reject(error);
  });
  return {
    child, ready: ready.promise, exited: exited.promise, events,
    command(action, fields = {}) {
      const requestId = ++next;
      const pending = deferred(); replies.set(requestId, pending);
      child.send({ action, requestId, ...fields });
      return pending.promise;
    },
    waitFor(event) {
      const seen = events.find(item => item.event === event);
      if (seen) return Promise.resolve(seen);
      const pending = deferred(); observers.set(event, [...(observers.get(event) ?? []), pending]); return pending.promise;
    },
    async stop() {
      if (child.exitCode === null && child.signalCode === null && child.connected) await this.command('stop');
      return exited.promise;
    }
  };
}

let fakeProcess = 4500000;
export async function publishHost(binding, id, startedAt = '2026-01-01T00:00:00.000Z') {
  const file = path.join(binding.paths.dataRootPath, 'host-liveness', `${id}.json`);
  await fs.mkdir(path.dirname(file), { recursive: true });
  const temporary = `${file}.tmp`;
  await fs.writeFile(temporary, JSON.stringify({ kind: 'limcode-runtime-host-liveness', dataSetId: binding.dataSetId,
    rootInstanceId: binding.rootInstanceId, rootGeneration: binding.rootGeneration, hostBootId: id,
    livenessId: `${id}-liveness`, processId: process.pid, processStartIdentity: ownProcessStartIdentity(),
    startedAt, heartbeatAt: NOW }));
  await fs.rename(temporary, file);
  return file;
}
export async function fakePeer(t, binding, id, options = {}) {
  const file = await publishHost(binding, id, options.startedAt);
  let busy = options.busy, participant, closing;
  const log = [];
  const peer = { log, setBusy: value => { busy = value; }, releases: () => log.filter(item => item[0] === 'release').length };
  participant = exclusive.startExclusiveMaintenanceParticipant(binding.paths, id, {
    busyReason: async () => busy,
    confirm: async request => { log.push(['confirm', request.round]); options.onConfirm?.(request); return true; },
    release: async request => {
      log.push(['release', request.round]); options.onRelease?.(request);
      const current = participant; participant = undefined;
      closing = (async () => { await current.dispose(); await fs.rm(file, { force: true }); await current.unregister(); })();
      await closing;
    }
  }, { pollMs: 2, processId: ++fakeProcess });
  await participant.checkNow();
  peer.close = async () => {
    await closing;
    await participant?.dispose(); await fs.rm(file, { force: true }); await participant?.unregister(); participant = undefined;
  };
  t.after(peer.close);
  return peer;
}

export function runMaintenance(f, database, key, options, operation) {
  return exclusive.runExclusiveRuntimeMaintenance(f.current.binding.paths, {
    operation: 'historical-merge', operationKey: key, message: '为合并历史', ignoreBackoff: true,
    // Independent coordination journeys share a root; the existing timing option prevents one
    // completed journey's production cooldown from becoming the next journey's input.
    requesterHostBootId: database.hostBootId, configurationRootPath: f.root, pollMs: 2, cooldownAfterCoordinatedMs: 0,
    withLocks: body => control.withRuntimeDataRootAdmission(f.root,
      () => control.withRuntimeMaintenance(f.current.binding.paths, body)), ...options
  }, operation);
}
export async function publishRequest(paths, requestId, phase) {
  const target = path.join(exclusive.runtimeExclusiveMaintenanceDirectory(paths), 'requests', `${requestId}.json`);
  await fs.mkdir(path.dirname(target), { recursive: true });
  const now = new Date().toISOString();
  const temporary = `${target}.tmp`;
  await fs.writeFile(temporary, JSON.stringify({ kind: 'limcode-runtime-exclusive-maintenance-request', requestId, round: 1,
    phase, operation: 'offline-gc', operationKey: requestId, message: '为整理历史', activity: '整理历史', confirmation: 'notice',
    whenBusy: 'wait', createdAt: now, requesterProcessId: process.pid, requesterProcessStartIdentity: ownProcessStartIdentity(),
    heartbeatAt: now, expiresAt: new Date(Date.now() + 60000).toISOString() }));
  await fs.rename(temporary, target);
}

class Uri {
  constructor(value) { this.fsPath = path.resolve(value); this.path = this.fsPath; this.scheme = 'file'; this.authority = ''; }
  static file(value) { return new Uri(value); }
  static parse(value) { return new Uri(value.replace(/^file:\/\//, '')); }
  static joinPath(base, ...parts) { return new Uri(path.join(base.fsPath, ...parts)); }
  with(value) { return new Uri(value.path ?? this.path); }
  toString() { return `file://${this.fsPath}`; }
}
class EventEmitter {
  listeners = new Set();
  event = listener => { this.listeners.add(listener); return { dispose: () => this.listeners.delete(listener) }; };
  fire(value) { for (const listener of this.listeners) listener(value); }
  dispose() { this.listeners.clear(); }
}
export const vscodeStub = {
  Uri, EventEmitter, ViewColumn: { One: 1 }, FileType: { Unknown: 0, File: 1, Directory: 2, SymbolicLink: 64 },
  ProgressLocation: { Notification: 1 },
  workspace: { workspaceFolders: [], name: 'fixture', fs: {
    createDirectory: uri => fs.mkdir(uri.fsPath, { recursive: true }), readFile: uri => fs.readFile(uri.fsPath),
    writeFile: (uri, bytes) => fs.writeFile(uri.fsPath, bytes), delete: uri => fs.rm(uri.fsPath, { recursive: true, force: true }),
    async stat(uri) { const info = await fs.stat(uri.fsPath); return { type: info.isDirectory() ? 2 : 1, size: info.size, ctime: info.ctimeMs, mtime: info.mtimeMs }; }
  } },
  window: { state: { focused: false }, async showInformationMessage() {}, async showWarningMessage() {}, async showErrorMessage() {},
    registerWebviewPanelSerializer: () => ({ dispose() {} }),
    withProgress: (options, task) => task({ report() {} }, { isCancellationRequested: false, onCancellationRequested() {} }) },
  commands: { async executeCommand() {} }
};
export function loadVscode(relative) {
  const original = Module._load;
  Module._load = function(name, parent, isMain) { return name === 'vscode' ? vscodeStub : original.call(this, name, parent, isMain); };
  try { return require(path.join(compiled, relative)); } finally { Module._load = original; }
}
export function dmsLock(shmPath) {
  if (process.platform === 'win32') return Promise.resolve('windows-lock');
  return new Promise((resolve, reject) => execFile('python3', ['-c',
    'import fcntl,os,sys\nf=os.open(sys.argv[1],os.O_RDWR)\ntry:\n fcntl.lockf(f,fcntl.LOCK_EX|fcntl.LOCK_NB,1,128); print("acquired")\nexcept OSError:\n print("held")', shmPath],
  (error, stdout) => error ? reject(error) : resolve(stdout.trim())));
}

export async function freezeWindow(dataSet) {
  const { ReliableConversationRunner } = loadVscode('backend/application/reliableKernel/ReliableConversationRunner.js');
  const { VscodeReliableKernelApplicationFacade: Facade } = loadVscode('backend/application/reliableKernel/VscodeReliableKernelApplicationFacade.js');
  const { VscodeReliableKernelProductRuntime: Product, freezableClaimProbe } = loadVscode('backend/application/reliableKernel/VscodeReliableKernelProductRuntime.js');
  const { VscodeReliableKernelCommandRouter: Router } = loadVscode('backend/application/reliableKernel/VscodeReliableKernelCommandRouter.js');
  const { RuntimeWriteGate } = loadVscode('backend/application/reliableKernel/runtimeWriteGate.js');
  const eligibility = loadVscode('backend/application/reliableKernel/conversationHostEligibility.js');
  const started = deferred();
  const provider = { providerId: 'ci-freeze-provider', calls: 0, started: started.promise,
    async sendFullRequest(_request, controls) { this.calls++; started.resolve();
      await controls.onEvent({ kind: 'completed', streamSeq: '1', content: { role: 'model', parts: [{ text: '完成' }] } }); } };
  const app = await kernel.ReliableKernelApplication.open(dataSet.authority, {
    authorityCompiler: { async compile(request) { return { turnId: request.turnId, executorAgentId: request.executorAgentId,
      executionPreset: { content: JSON.stringify({ providerConfigId: provider.providerId, modelId: 'ci-freeze-model' }) },
      authoritySnapshot: { content: JSON.stringify({ kind: 'effective-turn-authority', turnId: request.turnId,
        conversationId: request.conversationId, executorAgentId: request.executorAgentId,
        model: { providerConfigId: provider.providerId, provider: 'fixture', modelId: 'ci-freeze-model', retryPolicy: { enabled: false, maxRetries: 0 } },
        modelProfile: { compressionThresholdTokens: 100000, contextWindowTokens: 128000, tokenEstimator: { kind: 'utf8-bytes-ceil', bytesPerToken: 4 } },
        toolPolicy: { id: 'ci-freeze-tools', allowedTools: [], preset: 'custom', toolConfigs: {}, sourceConfigs: {} },
        planReviewPolicy: { mode: 'optional' }, systemPrompt: { id: 'ci-freeze-prompt', text: '' },
        runtimeContext: { id: null, name: '', template: '' },
        workEnvironmentPolicy: { id: null, enabled: false, allowedWorkEnvironmentIds: [], defaultWorkEnvironmentId: null } }) } }; } },
    resolveWorkEnvironment: async () => undefined,
    mcpConnections: { async toolAnnotations() { return {}; }, async callTool() { return null; } },
    mcpPolicyGate: { async authorize() { return { toolPolicyAllowed: true, planReviewAllowed: true }; } },
    attachmentSettings: { async loadGlobalSettings() { return { section: 'attachments', settings: { maxStoredInlineFileMb: 25 }, filePath: 'settings/attachments.json' }; } },
    providers: { resolve: () => provider },
    createToolDispatcher: ({ database, contentStore, runtime, files, fileMutations, processes, mcp, interactions }) =>
      new kernel.ReliableToolDispatcher({ database, contentStore, effects: runtime.effects, files, fileMutations, processes, mcp, interactions,
        host: { definitions: () => [], async cancelTurnWaits() {}, async dispose() {} } })
  });
  const runner = new ReliableConversationRunner(app, `ci-freeze:${app.database.hostBootId}`, () => {}, undefined, undefined);
  const gate = { frozen: 0 }, owners = app.database.conversationOwners;
  const probe = eligibility.createDiagnosedConversationHostEligibility(id => eligibility.evaluateConversationHostEligibility({
    database: app.database, contentStore: app.contentStore, workspaceFolderUris: () => [], workEnvironments: async () => []
  }, id));
  owners.setClaimEligibilityProbe(freezableClaimProbe(gate, owners, async id => (await probe(id)).eligible));
  runner.setEntryEligibility(async (id, options) => (await eligibility.evaluateConversationEntryEligibility({
    database: app.database, contentStore: app.contentStore, workspaceFolderUris: () => [], workEnvironments: async () => [],
    nextTurnWorkEnvironment: (conversationId, next) => app.turns.previewNextTurnWorkEnvironment(conversationId, next?.executorAgentId)
  }, id, options)).eligible ? 'eligible' : 'ineligible');
  const product = { application: app, conversations: runner, childAgents: { async resume() { return false; } },
    debugCapture: { setListener() {} }, toolHost: { setStateChangeListener() {} }, async ensureCapabilitiesReady() {},
    conversationHostEligibility: id => eligibility.viewConversationHostEligibility(probe, id),
    freezeNewExecution: owned => Product.prototype.freezeNewExecution.call({ executionGate: gate }, owned) };
  const facade = Object.assign(Object.create(Facade.prototype), { product, writeGate: new RuntimeWriteGate(),
    historyEntries: [], refreshConversationHistory: async () => {} });
  const router = new Router(product, { writeGate: facade.writeGate });
  let next = 0;
  return { app, runner, provider, facade,
    async send(message) {
      const id = `ci-freeze-${++next}`, posted = [], done = deferred();
      router.handle('ci-freeze-client', { async postMessage(value) { posted.push(value);
        if (value.correlationId === id) done.resolve(); return true; } }, { id, channel: 'command', ...message });
      await done.promise; return posted;
    },
    async close() { runner.dispose(); await app.beginHandoff(); await runner.waitForIdle(); await app.close(); }
  };
}
