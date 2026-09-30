import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { createRequire } from 'node:module';
import test from 'node:test';

const compiled = path.resolve(process.env.LIMCODE_TEST_EXTENSION_ROOT ?? 'dist/extension', 'vscode/views/SidebarEntryView.js');
const require = createRequire(compiled);
const flush = async () => { for (let i = 0; i < 20; i++) await Promise.resolve(); };
function fixture(t) {
  let now = 0, id = 0, provider, receive, viewDisposed, historyListener, revealListener;
  const timers = new Map(), requests = [], posted = [], pending = [];
  let hold = false;
  const disposable = () => ({ dispose() {} });
  const scope = { kind: 'project', folderUri: 'file:///p' };
  const backend = {
    onDidChangeConversationHistory(fn) { historyListener = fn; return disposable(); },
    onDidRevealConversationHistoryTop(fn) { revealListener = fn; return disposable(); },
    async getConversationHistoryPage(input) {
      requests.push({ at: now, ...input });
      if (hold) await new Promise((resolve, reject) => pending.push({ resolve, reject }));
      return { scope, entries: [], originLinks: [], pageInfo: { cursor: input.cursor,
        pageIndex: input.cursor ? 2 : 0, pageSize: 50, total: 0, hasNext: false, hasPrevious: false } };
    },
    getCurrentProjectHistoryScope: () => scope, getProjectFolderCandidates: () => []
  };
  const sandbox = {
    exports: {}, console,
    setTimeout(fn, delay) { const key = ++id; timers.set(key, { fn, at: now + delay }); return key; },
    clearTimeout(key) { timers.delete(key); },
    require(name) {
      if (name === 'vscode') return {
        window: { registerWebviewViewProvider(_id, value) { provider = value; return disposable(); }, onDidChangeActiveTextEditor: disposable },
        workspace: { onDidChangeWorkspaceFolders: disposable }, Uri: { joinPath: () => ({}) }
      };
      if (name === '../panels/MainPanel') return { MainPanel: { onDidChangeConversationPanelState: disposable, getOpenConversationPanelStates: () => [] } };
      if (name === '../webview/getWebviewHtml') return { getWebviewHtml: () => 'ready', getUnavailableWebviewHtml: () => 'unavailable' };
      return require(name);
    }
  };
  // Run in this realm so the production plain-data guard also checks real payloads.
  const load = vm.runInThisContext(`(function(exports, require, setTimeout, clearTimeout) {${fs.readFileSync(compiled, 'utf8')}\n})`, { filename: compiled });
  load(sandbox.exports, sandbox.require, sandbox.setTimeout, sandbox.clearTimeout);
  sandbox.exports.registerSidebarEntryView({ extensionUri: {}, subscriptions: [] }, { wait: async () => backend });
  const webview = { options: {}, html: '', onDidReceiveMessage(fn) { receive = fn; return disposable(); },
    async postMessage(value) { posted.push(value); return true; } };
  provider.resolveWebviewView({ webview, onDidDispose(fn) { viewDisposed = fn; return disposable(); } });
  t.after(() => provider.dispose());
  return {
    provider, webview, requests, posted, timers,
    request(cursor, scopeKind = 'project') { receive({ type: 'sidebar.historyPage.get', scopeKind, projectFolderUri: 'file:///p', cursor }); },
    change() { historyListener(); },
    reveal() { revealListener({ conversationId: 'new', projectFolderUri: 'file:///p' }); },
    hold() { hold = true; }, release() { hold = false; for (const item of pending.splice(0)) item.resolve(); },
    reject() { hold = false; for (const item of pending.splice(0)) item.reject(new Error('stale read')); },
    closeView() { viewDisposed(); },
    async advance(ms) {
      const end = now + ms;
      while (true) {
        const next = [...timers].filter(([, timer]) => timer.at <= end).sort((a, b) => a[1].at - b[1].at)[0];
        if (!next) break;
        now = next[1].at; timers.delete(next[0]); next[1].fn(); await flush();
      }
      now = end; await flush();
    }
  };
}
test('continuous 100ms history events make bounded progress and retain the current page', async (t) => {
  const h = fixture(t); h.request('page-2'); await flush();
  for (let i = 0; i < 50; i++) { h.change(); await h.advance(100); }
  assert.equal(h.requests.length, 26, 'initial page plus one refresh per two events');
  assert.equal(h.requests[1].at, 180);
  assert.ok(h.requests.every((request) => request.cursor === 'page-2'));
  assert.equal(h.posted.length, h.requests.length);
  h.change(); await h.advance(179); assert.equal(h.requests.length, 26);
  await h.advance(1); assert.equal(h.requests.length, 27, 'final dirty update is delivered without another event');
  await h.advance(1000); assert.equal(h.requests.length, 27, 'idle sidebar does not poll');
});
test('slow automatic reads are not superseded by continuous events and get one trailing refresh', async (t) => {
  const h = fixture(t); h.request('page-2'); await flush(); h.hold();
  h.change(); await h.advance(180);
  for (let i = 0; i < 20; i++) { h.change(); await h.advance(100); }
  assert.equal(h.requests.length, 2, 'at most one automatic read in flight');
  h.release(); await flush();
  assert.equal(h.posted.length, 2, 'slow result remains publishable');
  await h.advance(180);
  assert.equal(h.requests.length, 3); assert.equal(h.posted.length, 3);
  await h.advance(1000); assert.equal(h.requests.length, 3);
});
test('reveal and explicit navigation fence old reads and preserve the latest scope', async (t) => {
  const h = fixture(t); h.request('page-2'); await flush(); h.hold();
  h.change(); await h.advance(180); h.reveal(); h.release(); await flush();
  assert.equal(h.posted.length, 1, 'reveal invalidates the old page');
  await h.advance(180);
  assert.equal(h.requests.at(-1).cursor, undefined);
  h.hold(); h.change(); await h.advance(180); h.request('all-page', 'all'); await flush();
  h.release(); await flush();
  assert.equal(h.posted.at(-1).activeScopeKind, 'all');
  assert.equal(h.posted.at(-1).history.pageInfo.cursor, 'all-page');
});
test('view/provider disposal drops pending refreshes and late success or failure', async (t) => {
  const h = fixture(t); h.request('page-2'); await flush(); h.hold();
  h.change(); await h.advance(180); h.change(); h.closeView(); h.release(); await flush();
  await h.advance(1000); assert.equal(h.posted.length, 1); assert.equal(h.requests.length, 2);
  h.provider.refreshConversationHistory(); assert.equal(h.timers.size, 0);
  const other = fixture(t); other.request(); await flush(); other.hold();
  other.change(); await other.advance(180); other.provider.dispose(); other.reject(); await flush();
  assert.equal(other.webview.html, 'ready'); assert.equal(other.posted.length, 1);
  other.provider.refreshConversationHistory(); assert.equal(other.timers.size, 0);
});
