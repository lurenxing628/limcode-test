import assert from 'node:assert/strict';
import fs from 'node:fs';
import promises from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import vm from 'node:vm';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const compiled = path.resolve(process.env.LIMCODE_TEST_EXTENSION_ROOT ?? 'dist/extension');
const kernel = require(path.join(compiled, 'backend/reliableKernel/index.js'));
const NativeDatabase = require('better-sqlite3');
const { createRuntimeSchemaSql } = require(path.join(compiled, 'backend/reliableKernel/schema/domainManifest.js'));
export const projection = require(path.join(compiled, 'backend/reliableKernel/clientProjection.js'));
const Module = require('node:module'), originalLoad = Module._load;
Module._load = function(name, parent, isMain) {
  return name === 'vscode' ? { EventEmitter: class { event = () => {}; }, Uri: { parse: text => ({ toString: () => text }) },
    TabInputText: class {}, window: {}, workspace: {} } : originalLoad.call(this, name, parent, isMain);
};
let Facade;
try { ({ VscodeReliableKernelApplicationFacade: Facade } = require(path.join(compiled, 'backend/application/reliableKernel/VscodeReliableKernelApplicationFacade.js'))); }
finally { Module._load = originalLoad; }
export const P = 'file:///ui/project-p', Q = 'file:///ui/project-q';
const NOW = '2000-01-01T00:00:00Z';
const { RuntimeWriteGate } = require(path.join(compiled, 'backend/application/reliableKernel/runtimeWriteGate.js'));
const row = (domain, value) => kernel.DOMAIN_REPOSITORIES.domain(domain).insert(value);

export async function createHistoryFixture(t) {
  const directory = await promises.mkdtemp(path.join(os.tmpdir(), 'limcode-ui-history-'));
  const root = await kernel.resetCandidateRuntimeRoot(directory);
  const database = await kernel.RuntimeDatabase.open(root.authority);
  t.after(async () => { await database.close(); await promises.rm(directory, { recursive: true, force: true }); });
  let clock = 0;
  const at = () => new Date(Date.parse(NOW) + ++clock * 1000).toISOString();
  await database.transaction([row('ProjectContext', { id: 'p', kind: 'folder', uri: P, name: 'P', created_at: NOW, updated_at: NOW }),
    row('ProjectContext', { id: 'q', kind: 'folder', uri: Q, name: 'Q', created_at: NOW, updated_at: NOW })]);
  const steps = [];
  function conversation(id, project, time) {
    return [row('Conversation', { id, title: id, status: 'active', created_at: time, updated_at: time }),
      ...(project ? [row('ConversationProjectLink', { id: `${id}-project`, conversation_id: id, project_context_id: project,
        role: 'primary', created_at: time, updated_at: time })] : [])];
  }
  for (let i = 1; i <= 13; i++) {
    steps.push(...conversation(`p-${String(i).padStart(2, '0')}`, 'p', at()));
    if (i % 3 === 0) steps.push(...conversation(`q-${i}`, 'q', at()));
    if (i % 5 === 0) steps.push(...conversation(`unbound-${i}`, null, at()));
  }
  await database.transaction(steps);
  const reveals = [], facade = Object.create(Facade.prototype);
  Object.assign(facade, { product: { application: { database }, configuration: { agents: async () => [] } }, historyEntries: [], originLinks: [],
    historyPreviewByRevisionId: new Map(), historyTitleByRevisionId: new Map(), historyRevealEmitter: { fire: value => reveals.push(value) },
    historyEmitter: { fire() {} }, writeGate: new RuntimeWriteGate(), disposed: false, startHydration: async () => {} });
  return { database, facade, reveals,
    page(scopeKind = 'project', cursor) { return facade.getConversationHistoryPage({ scopeKind, projectFolderUri: scopeKind === 'project' ? P : undefined, cursor, limit: 5 }); },
    create(id, project = 'q') { return database.transaction(conversation(id, project, at())); },
    touch(id) { return database.transaction([kernel.DOMAIN_REPOSITORIES.domain('Conversation').update(id, { updated_at: at() })]); },
    remove(id) { return database.transaction([kernel.DOMAIN_REPOSITORIES.domain('Conversation').delete(id)]); },
    async order() {
      const native = new NativeDatabase(root.binding.paths.databasePath, { readonly: true });
      try { return native.prepare(`SELECT c.id FROM conversation c JOIN conversation_project_link l ON l.conversation_id=c.id
        JOIN project_context p ON p.id=l.project_context_id WHERE l.role='primary' AND p.uri=? ORDER BY c.updated_at DESC,c.id DESC`).all(P).map(row => row.id); }
      finally { native.close(); }
    }
  };
}

// Real schema and production SQL, isolated from content IO: these scenarios inspect query work,
// visible positions and referenced Turns; the worker-backed Facade scenarios above cover dispatch.
export function projectionDatabase(t) {
  const db = new NativeDatabase(':memory:'); for (const sql of createRuntimeSchemaSql()) db.exec(sql);
  db.defaultSafeIntegers(true); db.pragma('foreign_keys=ON'); t.after(() => db.close());
  const insert = (table, data) => db.prepare(`INSERT INTO ${table} (${Object.keys(data).join(',')}) VALUES (${Object.keys(data).map(() => '?').join(',')})`).run(...Object.values(data));
  insert('content_object', { id: 'body', content_type: 'text/plain', sha256: '0'.repeat(64), byte_length: 0, storage_key: 'unused', created_at: NOW });
  const conversation = id => insert('conversation', { id, title: id, status: 'active', created_at: NOW, updated_at: NOW });
  const message = (id, owner, sequence, role = 'user', deleted = false) => {
    insert('message', { id, created_at: NOW, updated_at: NOW, deleted_at: deleted ? NOW : null });
    insert('message_revision', { id: `r-${id}`, message_id: id, revision_seq: 1, role, content_object_id: 'body', created_at: NOW });
    insert('message_current_revision_link', { id: `c-${id}`, message_id: id, revision_id: `r-${id}`, updated_at: NOW });
    insert('message_part_of_conversation', { id: `p-${id}`, conversation_id: owner, message_id: id, message_seq: sequence, created_at: NOW });
  };
  const turn = (id, owner, status = 'terminated') => insert('turn', { id, conversation_id: owner, status, created_at: NOW, updated_at: NOW, terminal_at: status === 'active' ? null : NOW });
  const queries = [], prepare = db.prepare.bind(db); db.prepare = sql => { queries.push(sql); return prepare(sql); };
  return { db, insert, conversation, message, turn, queries };
}
export function visited(db, sql, params) {
  let count = 0;
  db.function('visit_membership', () => { count++; return 1; });
  const instrumented = sql.replace('WHERE membership.conversation_id =', 'WHERE visit_membership() AND membership.conversation_id =');
  db.prepare(instrumented).all(params); return count;
}

export async function flushMicrotasks() { for (let i = 0; i < 20; i++) await Promise.resolve(); }
export function sidebar(t) {
  let now = 0, id = 0, provider, receive, viewDisposed, historyListener, revealListener, hold = false;
  const timers = new Map(), requests = [], posted = [], pending = [];
  const disposable = () => ({ dispose() {} }), scope = { kind: 'project', folderUri: P };
  const backend = { onDidChangeConversationHistory(fn) { historyListener = fn; return disposable(); },
    onDidRevealConversationHistoryTop(fn) { revealListener = fn; return disposable(); },
    async getConversationHistoryPage(input) {
      requests.push({ at: now, ...input });
      if (hold) await new Promise((resolve, reject) => pending.push({ resolve, reject }));
      return { scope, entries: [], originLinks: [], pageInfo: { cursor: input.cursor, pageIndex: input.cursor ? 2 : 0,
        pageSize: 50, total: 0, hasNext: false, hasPrevious: false } };
    }, getCurrentProjectHistoryScope: () => scope, getProjectFolderCandidates: () => [] };
  const file = path.join(compiled, 'vscode/views/SidebarEntryView.js');
  const load = vm.runInThisContext(`(function(exports, require, setTimeout, clearTimeout) {${fs.readFileSync(file, 'utf8')}\n})`, { filename: file });
  const exports = {}, localRequire = createRequire(file);
  load(exports, name => {
    if (name === 'vscode') return { window: { registerWebviewViewProvider(_id, value) { provider = value; return disposable(); }, onDidChangeActiveTextEditor: disposable },
      workspace: { onDidChangeWorkspaceFolders: disposable }, Uri: { joinPath: () => ({}) } };
    if (name === '../panels/MainPanel') return { MainPanel: { onDidChangeConversationPanelState: disposable, getOpenConversationPanelStates: () => [] } };
    if (name === '../webview/getWebviewHtml') return { getWebviewHtml: () => 'ready', getUnavailableWebviewHtml: () => 'unavailable' };
    return localRequire(name);
  }, (fn, delay) => { const key = ++id; timers.set(key, { fn, at: now + delay }); return key; }, key => timers.delete(key));
  exports.registerSidebarEntryView({ extensionUri: {}, subscriptions: [] }, { wait: async () => backend });
  const webview = { options: {}, html: '', onDidReceiveMessage(fn) { receive = fn; return disposable(); },
    async postMessage(value) { posted.push(structuredClone(value)); return true; } };
  provider.resolveWebviewView({ webview, onDidDispose(fn) { viewDisposed = fn; return disposable(); } });
  t.after(() => provider.dispose());
  return { provider, requests, posted, timers,
    request(cursor) { receive({ type: 'sidebar.historyPage.get', scopeKind: 'project', projectFolderUri: P, cursor }); },
    change() { historyListener(); }, reveal(folderUri = P) { revealListener({ conversationId: 'changed', projectFolderUri: folderUri }); },
    hold() { hold = true; }, release() { hold = false; for (const value of pending.splice(0)) value.resolve(); },
    closeView() { viewDisposed(); },
    async advance(ms) {
      const end = now + ms;
      for (;;) {
        const next = [...timers].filter(([, value]) => value.at <= end).sort((a, b) => a[1].at - b[1].at)[0]; if (!next) break;
        now = next[1].at; timers.delete(next[0]); next[1].fn(); await flushMicrotasks();
      }
      now = end; await flushMicrotasks();
    } };
}
