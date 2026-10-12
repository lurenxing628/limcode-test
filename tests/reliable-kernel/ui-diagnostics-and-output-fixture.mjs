import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { createRequire } from 'node:module';
import { createWebviewSsrServer } from './webview-ssr-server.mjs';

const require = createRequire(import.meta.url), Module = require('node:module');
export const built = path.resolve(process.env.LIMCODE_TEST_EXTENSION_ROOT ?? 'dist/extension');
export const load = file => require(path.join(built, file));
const threads = require('node:worker_threads');
export const diffWorkers = [];
class TrackedWorker extends threads.Worker {
  constructor(filename, options) {
    super(filename, options);
    if (path.basename(String(filename)) === 'fileDiffWorker.js') diffWorkers.push({ worker: this, filename: String(filename) });
  }
}
const originalLoad = Module._load;
let api, diff;
try {
  Module._load = function (request, parent, isMain) {
    return request === 'node:worker_threads' ? { ...threads, Worker: TrackedWorker } : originalLoad.call(this, request, parent, isMain);
  };
  api = load('backend/reliableKernel/index.js');
  diff = load('backend/capabilities/fileDiffAsync.js');
} finally { Module._load = originalLoad; }
export const kernel = api;
export const { buildFileDiffRecordAsync, FileDiffPreviewTooLargeError, FileDiffPreviewBusyError } = diff;
export const { RuntimeDiagnosticMetrics } = load('backend/reliableKernel/runtimeDiagnosticMetrics.js');
export const { DebugCaptureService } = load('backend/reliableKernel/debugCapture/service.js');
export const { DebugHttpObservation } = load('backend/reliableKernel/debugCapture/observer.js');
export const { createTerminalValidatedFetch } = load('backend/capabilities/terminalValidatedFetch.js');
export const deferred = () => { let resolve; const promise = new Promise(r => { resolve = r; }); return { promise, resolve }; };
export const repo = name => kernel.DOMAIN_REPOSITORIES.domain(name);

export async function createDiagnosticsFixture() {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'limcode-ui-diagnostics-'));
  const authority = new kernel.RootAuthority(() => path.join(directory, 'runtime'));
  const binding = await kernel.initializeEmptyRuntimeRoot(authority);
  let database, store;
  return { directory, authority, binding,
    async openDatabase() {
      if (!database) {
        database = await kernel.RuntimeDatabase.open(authority, { hostBootId: 'diagnostics-fixture' });
        store = kernel.ContentAddressedStore.forDatabase(authority, database);
      }
      return { database, store };
    },
    async seedDiff(before, after) {
      const { database, store } = await this.openDatabase(), now = new Date().toISOString();
      const base = await store.ingest(database, before, 'text/plain'), target = await store.ingest(database, after, 'text/plain');
      const args = await store.ingest(database, '{}', 'application/json');
      await database.transaction([
        repo('Conversation').insert({ id: 'diff-conversation', title: 'Diff', status: 'active', created_at: now, updated_at: now }),
        repo('Turn').insert({ id: 'diff-turn', conversation_id: 'diff-conversation', status: 'terminated', terminal_at: now, created_at: now, updated_at: now }),
        repo('ToolCall').insert({ id: 'diff-call', turn_id: 'diff-turn', call_seq: 1n, tool_name: 'apply_diff', status: 'terminal', arguments_object_id: args.id, created_at: now, updated_at: now }),
        repo('FileChangeSet').insert({ id: 'diff-set', tool_call_id: 'diff-call', status: 'applied', created_at: now, updated_at: now }),
        repo('FileChangeSetMember').insert({ id: 'diff-member', change_set_id: 'diff-set', member_seq: 1n, operation: 'replace_file',
          work_environment_id: 'diff-environment', target_path: '目录/😀.txt', base_digest: base.sha256, base_content_object_id: base.id,
          target_content_object_id: target.id, target_digest: target.sha256, created_at: now })
      ]);
      return { database, store, base, target, reader: new kernel.ClientDetailReader(database, store) };
    },
    async events() {
      const root = path.join(binding.paths.dataRootPath, 'diagnostics');
      const names = await fs.readdir(root).catch(error => error.code === 'ENOENT' ? [] : Promise.reject(error));
      const events = [];
      for (const name of names.filter(name => name.endsWith('.jsonl'))) {
        const text = await fs.readFile(path.join(root, name), 'utf8');
        for (const line of text.split('\n')) if (line) events.push(JSON.parse(line));
      }
      return events;
    },
    async close() { await database?.close(); await fs.rm(directory, { recursive: true, force: true }); }
  };
}

/** Real SQLite in this process's worker and a competing OS process, synchronized by replies. */
export async function sqlitePeers(directory) {
  const sqlitePath = require.resolve('better-sqlite3'), Database = require(sqlitePath);
  const file = path.join(directory, 'lock-boundary.sqlite'), setup = new Database(file);
  setup.pragma('journal_mode = WAL');
  setup.exec('CREATE TABLE t (id INTEGER PRIMARY KEY, v TEXT NOT NULL)');
  const insert = setup.prepare('INSERT INTO t (id, v) VALUES (?, ?)');
  for (let id = 1; id <= 3; id++) insert.run(id, `v1${'x'.repeat(3000)}`);
  const worker = new threads.Worker(`
    const { parentPort, workerData } = require('node:worker_threads');
    const db = new (require(workerData.sqlitePath))(workerData.file); db.pragma('busy_timeout = 0');
    const value = id => db.prepare('SELECT substr(v, 1, 2) AS v FROM t WHERE id=?').get(id).v;
    parentPort.on('message', ({ id, command, rowId }) => { try {
      let result = null;
      if (command === 'begin-write') { db.exec('BEGIN IMMEDIATE'); db.prepare("INSERT INTO t(v) VALUES ('A')").run(); }
      else if (command === 'begin-read') { db.exec('BEGIN'); result = value(rowId); }
      else if (command === 'read') result = value(rowId);
      else if (command === 'commit') db.exec('COMMIT');
      else if (command === 'close') db.close();
      parentPort.postMessage({ id, result });
    } catch (error) { parentPort.postMessage({ id, error: String(error.code ?? error.message) }); } });
  `, { eval: true, workerData: { file, sqlitePath } });
  let serial = 0; const waiting = new Map();
  worker.on('message', message => { const waiter = waiting.get(message.id); waiting.delete(message.id);
    if (message.error) waiter?.reject(new Error(message.error)); else waiter?.resolve(message.result); });
  worker.on('error', error => { for (const waiter of waiting.values()) waiter.reject(error); waiting.clear(); });
  const inProcess = (command, rowId) => new Promise((resolve, reject) => {
    const id = ++serial; waiting.set(id, { resolve, reject }); worker.postMessage({ id, command, rowId });
  });
  const peer = spawn(process.execPath, ['-e', `
    const db = new (require(process.argv[2]))(process.argv[1]); db.pragma('busy_timeout = 0');
    let buffer = ''; process.stdin.setEncoding('utf8');
    process.stdin.on('data', chunk => { buffer += chunk; let index;
      while ((index = buffer.indexOf('\\n')) >= 0) {
        const command = buffer.slice(0, index); buffer = buffer.slice(index + 1); let reply;
        try {
          if (command === 'write') { db.exec('BEGIN IMMEDIATE'); db.prepare("INSERT INTO t(v) VALUES ('B')").run(); db.exec('COMMIT'); reply='ok'; }
          else if (command.startsWith('set ')) { db.prepare('UPDATE t SET v=? || substr(v,3) WHERE id<=3').run(command.slice(4)); reply='ok'; }
          else if (command === 'checkpoint') reply=JSON.stringify(db.pragma('wal_checkpoint(TRUNCATE)')[0]);
          else if (command === 'quit') { db.close(); process.stdout.write('bye\\n'); process.exit(0); }
        } catch (error) { try { db.exec('ROLLBACK'); } catch {} reply='err '+(error.code ?? error.message); }
        process.stdout.write(reply+'\\n');
      }
    }); process.stdout.write('ready\\n');
  `, file, sqlitePath], { stdio: ['pipe', 'pipe', 'pipe'] });
  let buffer = ''; const lines = [], readers = [];
  peer.stdout.setEncoding('utf8'); peer.stdout.on('data', chunk => { buffer += chunk; let index;
    while ((index = buffer.indexOf('\n')) >= 0) { const line = buffer.slice(0, index); buffer = buffer.slice(index + 1);
      const reader = readers.shift(); if (reader) reader.resolve(line); else lines.push(line); }
  });
  peer.on('error', error => { for (const reader of readers.splice(0)) reader.reject(error); });
  const next = () => lines.length ? Promise.resolve(lines.shift()) : new Promise((resolve, reject) => readers.push({ resolve, reject }));
  const ready = await next(); if (ready !== 'ready') throw new Error(`SQLite peer failed: ${ready}`);
  const otherProcess = command => { peer.stdin.write(`${command}\n`); return next(); };
  return { file, setup, inProcess, otherProcess,
    async close() { if (peer.exitCode === null) { const exiting = once(peer, 'exit'); await otherProcess('quit'); await exiting; }
      await worker.terminate(); setup.close(); }
  };
}

export async function createDetailStoreFixture() {
  const previousWindow = globalThis.window, posted = [];
  globalThis.window = { atob, setTimeout, clearTimeout, addEventListener() {}, removeEventListener() {},
    requestAnimationFrame() { return 1; }, cancelAnimationFrame() {},
    acquireVsCodeApi: () => ({ postMessage: message => posted.push(message), getState() {}, setState() {} }) };
  const server = await createWebviewSsrServer(), pinia = await import('pinia');
  const { useReliableKernelClientFeedStore } = await server.ssrLoadModule('/src/stores/useReliableKernelClientFeedStore.ts');
  pinia.setActivePinia(pinia.createPinia()); const store = useReliableKernelClientFeedStore();
  Object.assign(store, { sessionId: 'detail-session', hostBootId: 'detail-host', navigationGeneration: '7',
    projections: { activeConversationWindow: { conversationId: 'detail-conversation' } } });
  const requests = () => posted.filter(message => message.type === 'reliable-kernel.detail-request');
  return { store, posted, requests, latest: () => requests().at(-1),
    reply(request, text, { totalBytes = request.offset + Buffer.byteLength(text), hasMore = false } = {}) {
      const bytes = Buffer.from(text);
      store.observe({ type: 'reliable-kernel.detail-result', requestId: request.requestId, sessionId: request.sessionId,
        detail: { recordId: request.recordId, offset: request.offset, chunk: bytes.toString('base64'), encoding: 'base64',
          totalBytes, hasMore, responseBytes: bytes.length, ...(hasMore ? { nextOffset: request.offset + bytes.length } : {}) } });
    },
    fail(request, message, retryable = true) { store.observe({ type: 'reliable-kernel.detail-error', requestId: request.requestId,
      sessionId: request.sessionId, message, retryable }); },
    replaceSession() { store.observe({ type: 'reliable-kernel.snapshot', sessionId: 'next-detail-session', hostBootId: store.hostBootId,
      navigationGeneration: '7', messageSeq: '1', snapshotCommitSeq: '1', projections: { activeConversationWindow: { conversationId: 'detail-conversation' } } }); },
    async close() { store.$dispose(); await server.close(); globalThis.window = previousWindow; }
  };
}

export function loadBuiltEntry() {
  const original = Module._load;
  try {
    Module._load = function (request, parent, isMain) {
      if (request === 'vscode') return { EventEmitter: class { event = () => ({ dispose() {} }); fire() {} dispose() {} } };
      return original.call(this, request, parent, isMain);
    };
    return load('vscode/extension.js');
  } finally { Module._load = original; }
}
