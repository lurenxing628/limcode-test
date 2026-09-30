import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import { createWebviewSsrServer } from './webview-ssr-server.mjs';

let server, useStore, pinia, markRaw;
const posted = [];
const oldWindow = globalThis.window;
before(async () => {
  globalThis.window = {
    requestAnimationFrame() {}, addEventListener() {}, removeEventListener() {},
    setTimeout, clearTimeout, atob,
    acquireVsCodeApi: () => ({ postMessage: (message) => posted.push(message), getState() {}, setState() {} })
  };
  server = await createWebviewSsrServer();
  pinia = await import('pinia');
  ({ markRaw } = await import('vue'));
  ({ useReliableKernelClientFeedStore: useStore } = await server.ssrLoadModule('/src/stores/useReliableKernelClientFeedStore.ts'));
});
after(async () => { await server?.close(); globalThis.window = oldWindow; });
const message = (seq, conversation = 'c') => ({ id: `${conversation}-${seq}`, conversation_id: conversation,
  role: 'model', message_seq: String(seq), display_seq: String(seq), deleted_at: null });
function fixture(t, size = 1000) {
  pinia.setActivePinia(pinia.createPinia());
  const store = useStore();
  t.after(() => store.$dispose());
  Object.assign(store, { sessionId: 's', hostBootId: 'h', lastMessageSeq: '1', lastCommitSeq: '1',
    navigationGeneration: '2', projections: { activeConversationWindow: { conversationId: 'c', visibleMessageCount: String(size + 1) } },
    records: { Message: { [`c-${size + 1}`]: message(size + 1) } }, historyConversationId: 'c', historyLoadedPages: 1,
    collaborationHistoryConversationId: 'c', collaborationHistoryLoadedPages: 1 });
  let scans = 0;
  const rows = Object.fromEntries(Array.from({ length: size }, (_, i) => { const row = message(i + 1); return [row.id, row]; }));
  store.historyRecords = { Message: markRaw(new Proxy(rows, { ownKeys(target) { scans++; return Reflect.ownKeys(target); } })) };
  posted.length = 0;
  return { store, scans: () => scans };
}
function snapshot({ sessionId = 's', conversationId = 'c', count = 1001, first = 1001, generation = '2' } = {}) {
  return { type: 'reliable-kernel.snapshot', sessionId, hostBootId: 'h', navigationGeneration: generation,
    messageSeq: '2', snapshotCommitSeq: '2', projections: { activeConversationWindow: { conversationId,
      visibleMessageCount: String(count), messages: [message(first, conversationId)] } } };
}
test('lease-only durable updates ACK without enumerating the loaded history prefix', (t) => {
  const { store, scans } = fixture(t, 10000);
  for (let seq = 2; seq <= 21; seq++) store.observeData({ type: 'reliable-kernel.changes', sessionId: 's', hostBootId: 'h',
    messageSeq: String(seq), commitSeq: String(seq), changes: [{ type: 'ExecutionLease', operation: 'upsert', id: 'lease', record: { id: 'lease', expires_at: seq } }] });
  assert.equal(scans(), 0);
  assert.equal(posted.filter((row) => row.type === 'reliable-kernel.ack').length, 20);
  assert.equal(store.lastMessageSeq, '21');
  assert.equal(store.historyRecords.Message['c-1'].display_seq, '1');
});
test('accepted snapshots still invalidate truncated history and heal skipped floors on reconnect', (t) => {
  const a = fixture(t);
  a.store.observeData(snapshot({ count: 500, first: 500 }));
  assert.ok(a.scans() > 0);
  assert.equal(a.store.historyLoadedPages, 0);
  assert.deepEqual(a.store.historyRecords, {});
  const b = fixture(t);
  b.store.historyLoading = true;
  b.store.historyRequestId = 'old-request';
  b.store.observeData(snapshot({ sessionId: 'reconnected', count: 1400, first: 1400 }));
  assert.ok(b.scans() > 0);
  assert.equal(b.store.historyRecords.Message['c-1'].id, 'c-1');
  assert.equal(b.store.historyLoadedPages, 1);
  assert.equal(b.store.historyLoading, false);
  assert.equal(b.store.historyRequestId, null);
  assert.equal(b.store.historyNextBeforeMessageSeq, '1400');
  assert.ok(b.store.retiredSessionIds.includes('s'));
});
test('navigation and rejected envelopes do not inspect the old conversation history', (t) => {
  const a = fixture(t);
  a.store.observeData(snapshot({ conversationId: 'other', generation: '3' }));
  assert.equal(a.scans(), 0);
  assert.equal(a.store.historyConversationId, 'other');
  assert.equal(a.store.historyLoadedPages, 0);
  const b = fixture(t);
  b.store.observeData(snapshot({ generation: '1' }));
  b.store.observeData({ type: 'reliable-kernel.changes', sessionId: 's', hostBootId: 'h', messageSeq: '10', commitSeq: '10', changes: [] });
  assert.equal(b.scans(), 0);
  assert.equal(b.store.lastMessageSeq, '1');
  assert.equal(b.store.snapshotRequired, true);
});
test('ordinary window rollover still retains its message and later historical updates', (t) => {
  const { store } = fixture(t);
  store.observeData({ type: 'reliable-kernel.changes', sessionId: 's', hostBootId: 'h', messageSeq: '2', commitSeq: '2', changes: [
    { type: 'Message', operation: 'remove', id: 'c-1001', removalCause: 'window-eviction' },
    { type: 'Message', operation: 'upsert', id: 'c-1002', record: message(1002) }
  ] });
  assert.equal(store.historyRecords.Message['c-1001'].display_seq, '1001');
  assert.equal(store.records.Message['c-1001'], undefined);
  store.observeData({ type: 'reliable-kernel.changes', sessionId: 's', hostBootId: 'h', messageSeq: '3', commitSeq: '3', changes: [
    { type: 'Message', operation: 'upsert', id: 'c-1001', record: { ...message(1001), updated_at: 'updated' } }
  ] });
  assert.equal(store.historyRecords.Message['c-1001'].updated_at, 'updated');
  assert.equal(store.historyLoadedPages, 1);
});
test('a snapshot validates history while its first page is in flight, but skips unloaded history', (t) => {
  const a = fixture(t);
  a.store.historyLoadedPages = 0;
  a.store.historyLoading = true;
  a.store.historyRequestId = 'loading-first-page';
  a.store.observeData(snapshot({ count: 500, first: 500 }));
  assert.ok(a.scans() > 0);
  assert.equal(a.store.historyLoading, false);
  assert.equal(a.store.historyRequestId, null);
  const b = fixture(t);
  b.store.historyLoadedPages = 0;
  b.store.observeData(snapshot());
  assert.equal(b.scans(), 0);
});
