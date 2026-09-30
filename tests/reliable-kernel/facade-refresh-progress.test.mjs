import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { createRequire } from 'node:module';
import test from 'node:test';

const compiled = path.resolve(process.env.LIMCODE_TEST_EXTENSION_ROOT ?? 'dist/extension',
  'backend/application/reliableKernel/VscodeReliableKernelApplicationFacade.js');
const require = createRequire(compiled);
const attention = require('./interactionAttention.js');
const flush = async () => { for (let i = 0; i < 20; i++) await Promise.resolve(); };
function fixture() {
  let now = 0, id = 0, hold = false;
  const timers = new Map(), historyReads = [], attentionReads = [], historyEvents = [], attentionEvents = [], pending = [];
  const read = async (kind) => {
    (kind === 'history' ? historyReads : attentionReads).push(now);
    if (hold) await new Promise((resolve) => pending.push(resolve));
    return kind === 'history' ? { entries: [], originLinks: [] } : [];
  };
  const exports = {};
  const load = vm.runInThisContext(`(function(exports, require, setTimeout, clearTimeout) {${fs.readFileSync(compiled, 'utf8')}\n})`, { filename: compiled });
  load(exports, (name) => name === './interactionAttention'
    ? { ...attention, readPendingInteractionAttention: () => read('attention') } : {},
  (fn, delay) => { const key = ++id; timers.set(key, { fn, at: now + delay }); return key; },
  (key) => timers.delete(key));
  // Exercise the real facade methods with its I/O boundaries replaced, without opening a Runtime.
  const facade = Object.create(exports.VscodeReliableKernelApplicationFacade.prototype);
  Object.assign(facade, {
    disposed: false, historyRefreshPending: false, interactionAttentionRefreshPending: false,
    interactionLeaseEdges: { observe: () => false },
    interactionAttentionNotifier: { synchronize: () => attentionEvents.push(now), clear() {} },
    product: { application: { database: { hostBootId: 'host' } }, close: async () => {} },
    queryConversationHistoryPage: () => read('history'),
    historyEmitter: { fire: () => historyEvents.push(now), dispose() {} }, historyRevealEmitter: { dispose() {} },
    externalHistoryWatcher: { cancel() {} }, webviews: new Map()
  });
  return { facade, timers, historyReads, attentionReads, historyEvents, attentionEvents,
    commit(domain = 'Message') { facade.onRuntimeCommit({ changes: [{ domain, kind: 'upsert', id: 'id', record: {} }] }); },
    hold() { hold = true; }, release() { hold = false; for (const resolve of pending.splice(0)) resolve(); },
    async advance(ms) {
      const end = now + ms;
      while (true) {
        const next = [...timers].filter(([, item]) => item.at <= end).sort((a, b) => a[1].at - b[1].at)[0];
        if (!next) break;
        now = next[1].at; timers.delete(next[0]); next[1].fn(); await flush();
      }
      now = end; await flush();
    }
  };
}
test('facade history and interaction refreshes make progress throughout continuous relevant commits', async () => {
  const h = fixture();
  for (let i = 0; i < 500; i++) { h.commit(); h.commit('InteractionRequest'); await h.advance(10); }
  assert.equal(h.historyReads[0], 25);
  assert.equal(h.attentionReads[0], 25);
  assert.ok(h.historyReads.length >= 166);
  assert.ok(h.attentionReads.length >= 166);
  assert.equal(h.historyEvents.length, h.historyReads.length);
  assert.equal(h.attentionEvents.length, h.attentionReads.length);
  await h.advance(25);
  const counts = [h.historyReads.length, h.attentionReads.length];
  await h.advance(1000);
  assert.deepEqual([h.historyReads.length, h.attentionReads.length], counts);
  await h.facade.dispose();
});
test('slow facade reads coalesce dirty edges and publish one trailing state without overlap', async () => {
  const h = fixture(); h.hold(); h.commit(); h.commit('InteractionRequest'); await h.advance(25);
  for (let i = 0; i < 50; i++) { h.commit(); h.commit('InteractionRequest'); await h.advance(10); }
  await h.advance(25);
  assert.equal(h.historyReads.length, 1); assert.equal(h.attentionReads.length, 1);
  h.release(); await flush();
  assert.equal(h.historyReads.length, 2); assert.equal(h.attentionReads.length, 2);
  assert.equal(h.historyEvents.length, 2); assert.equal(h.attentionEvents.length, 2);
  await h.facade.dispose();
});
test('facade disposal cancels pending deadlines and ignores late reads', async () => {
  const h = fixture(); h.hold(); h.commit(); h.commit('InteractionRequest'); await h.advance(25);
  h.commit(); h.commit('InteractionRequest'); await h.facade.dispose(); h.release(); await flush();
  assert.equal(h.historyEvents.length, 0); assert.equal(h.attentionEvents.length, 0);
  await h.advance(1000);
  h.commit(); h.commit('InteractionRequest');
  await h.facade.refreshConversationHistory(); await h.facade.refreshInteractionAttention();
  assert.equal(h.timers.size, 0);
  assert.equal(h.historyReads.length, 1); assert.equal(h.attentionReads.length, 1);
});
