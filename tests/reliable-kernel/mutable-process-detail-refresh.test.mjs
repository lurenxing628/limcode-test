import assert from 'node:assert/strict';
import test from 'node:test';
import { createRequire } from 'node:module';
import { createWebviewSsrServer } from './webview-ssr-server.mjs';

const require = createRequire(import.meta.url);
const vue = require('vue');
const { renderToString } = require('@vue/server-renderer');

const processId = 'mutable-detail-process';
const conversationId = 'mutable-detail-conversation';
const kind = 'process-stdout';
const key = `${kind}:${processId}`;
const byteLength = text => Buffer.byteLength(text, 'utf8');

async function fixture(t, { panel = false } = {}) {
  const previousWindow = globalThis.window;
  const originalSetTimeout = globalThis.setTimeout;
  const originalClearTimeout = globalThis.clearTimeout;
  const posted = [];
  const timers = new Map();
  let timerId = 0;
  let persistedState;
  globalThis.window = {
    atob,
    addEventListener() {}, removeEventListener() {},
    requestAnimationFrame(callback) { callback(performance.now()); return 1; },
    cancelAnimationFrame() {},
    acquireVsCodeApi: () => ({
      postMessage(message) { posted.push(message); },
      getState: () => persistedState,
      setState(value) { persistedState = value; }
    })
  };
  const server = await createWebviewSsrServer();
  let store;
  t.after(async () => {
    store?.$dispose();
    globalThis.setTimeout = originalSetTimeout;
    globalThis.clearTimeout = originalClearTimeout;
    if (previousWindow === undefined) delete globalThis.window;
    else globalThis.window = previousWindow;
    await server.close();
  });
  const pinia = await import('pinia');
  const { useReliableKernelClientFeedStore } = await server.ssrLoadModule('/src/stores/useReliableKernelClientFeedStore.ts');
  const instance = pinia.createPinia();
  pinia.setActivePinia(instance);
  store = useReliableKernelClientFeedStore();
  const Panel = panel ? (await server.ssrLoadModule('/src/components/input/BackgroundCommandPanel.vue')).default : undefined;
  Object.assign(store, {
    sessionId: 'mutable-detail-session', hostBootId: 'mutable-detail-host', navigationGeneration: '7',
    projections: { activeConversationWindow: { conversationId } }
  });
  // Install only after Vite has loaded the modules; no Runtime, compiled extension or real timers
  // are involved in the detail transport and its bounded retry schedule.
  globalThis.setTimeout = (callback, delay = 0) => {
    const id = ++timerId;
    timers.set(id, { callback, delay: Number(delay) });
    return id;
  };
  globalThis.clearTimeout = id => timers.delete(id);
  const requests = () => posted.filter(message => message.type === 'reliable-kernel.detail-request');
  return {
    store, posted, requests, Panel, pinia: instance,
    latest() { const request = requests().at(-1); assert.ok(request); return request; },
    seed(text, detailKind = kind, recordId = processId) {
      store.details[`${detailKind}:${recordId}`] = { status: 'ready', text, totalBytes: byteLength(text) };
    },
    reply(request, text, { totalBytes = request.offset + byteLength(text), hasMore = false } = {}) {
      const bytes = Buffer.from(text, 'utf8');
      store.observe({
        type: 'reliable-kernel.detail-result', requestId: request.requestId, sessionId: request.sessionId,
        detail: {
          recordId: request.recordId, offset: request.offset, chunk: bytes.toString('base64'), encoding: 'base64',
          totalBytes, hasMore, responseBytes: bytes.byteLength,
          ...(hasMore ? { nextOffset: request.offset + bytes.byteLength } : {})
        }
      });
    },
    fail(request, message, retryable = true) {
      store.observe({
        type: 'reliable-kernel.detail-error', requestId: request.requestId, sessionId: request.sessionId,
        message, retryable
      });
    },
    runRetry(delay) {
      const entry = [...timers].find(([, timer]) => timer.delay === delay);
      assert.ok(entry, `expected a ${delay}ms automatic retry`);
      timers.delete(entry[0]);
      entry[1].callback();
    },
    retryDelays() { return [...timers.values()].filter(timer => timer.delay < 20_000).map(timer => timer.delay); },
    replaceSession() {
      store.observe({
        type: 'reliable-kernel.snapshot', sessionId: 'mutable-detail-next-session', hostBootId: store.hostBootId,
        navigationGeneration: '7', messageSeq: '1', snapshotCommitSeq: '1',
        projections: { activeConversationWindow: { conversationId } }
      });
    }
  };
}

test('mutable process refresh demand during a frozen multi-chunk prefix gets exactly one trailing read', async t => {
  const h = await fixture(t);
  for (const detailKind of ['process-stdout', 'process-stderr']) {
    h.posted.length = 0;
    const detailKey = `${detailKind}:${processId}`;
    const prefix = '已完成🚀\n';
    const frozen = `${prefix}first\nsecond\n`;
    h.seed(prefix, detailKind);
    h.store.refreshDetail(detailKind, processId, { priority: 'expanded' });
    const first = h.latest();
    assert.equal(first.offset, byteLength(prefix));
    assert.equal(first.expectedTotalBytes, undefined);
    for (let i = 0; i < 5; i++) h.store.refreshDetail(detailKind, processId, { priority: 'expanded' });
    assert.equal(h.requests().length, 1, 'in-flight demand coalesces without another transport request');

    h.reply(first, 'first\n', { totalBytes: byteLength(frozen), hasMore: true });
    const continuation = h.latest();
    assert.equal(continuation.requestId, first.requestId);
    assert.equal(continuation.offset, byteLength(`${prefix}first\n`));
    assert.equal(continuation.expectedTotalBytes, byteLength(frozen), 'continuations keep the original frozen total');
    assert.equal(h.store.details[detailKey].text, prefix, 'the last complete prefix stays renderable during partial reads');
    for (let i = 0; i < 5; i++) h.store.refreshDetail(detailKind, processId);
    assert.equal(h.requests().length, 2, 'new output demand cannot reopen the current frozen read');

    h.reply(continuation, 'second\n', { totalBytes: byteLength(frozen) });
    const trailing = h.latest();
    assert.equal(h.requests().length, 3, 'all demand during the prior read creates one trailing read');
    assert.notEqual(trailing.requestId, first.requestId);
    assert.equal(trailing.offset, byteLength(frozen));
    assert.equal(trailing.expectedTotalBytes, undefined, 'the trailing read may discover the final process output');
    assert.equal(h.store.details[detailKey].text, frozen);
    assert.equal(Object.keys(h.store.pendingDetails).length, 1);
    h.reply(trailing, 'final✅\n');
    assert.equal(h.store.details[detailKey].text, `${frozen}final✅\n`);
    assert.equal(h.store.details[detailKey].totalBytes, byteLength(`${frozen}final✅\n`));
    assert.equal(h.requests().length, 3, 'successful completion consumes the one trailing demand');
    assert.equal(Object.keys(h.store.pendingDetails).length, 0);
  }
});

test('refresh demand during an initial process detail read also follows its completed prefix once', async t => {
  const h = await fixture(t);
  h.store.requestDetail(kind, processId);
  const initial = h.latest();
  for (let i = 0; i < 5; i++) h.store.refreshDetail(kind, processId);
  assert.equal(h.requests().length, 1);
  assert.equal(h.store.details[key].status, 'loading');
  h.reply(initial, 'initial\n');
  const trailing = h.latest();
  assert.equal(h.requests().length, 2);
  assert.notEqual(trailing.requestId, initial.requestId);
  assert.equal(trailing.offset, byteLength('initial\n'));
  assert.equal(h.store.details[key].text, 'initial\n');
  h.reply(trailing, 'completed\n');
  assert.equal(h.store.details[key].text, 'initial\ncompleted\n');
  assert.equal(h.requests().length, 2);
});

test('same-session reload cancels the old trailing demand and ignores its late completion', async t => {
  const h = await fixture(t);
  h.seed('old\n');
  h.store.refreshDetail(kind, processId);
  const cancelled = h.latest();
  h.store.refreshDetail(kind, processId);
  h.store.reloadDetail(kind, processId);
  const replacement = h.latest();
  assert.notEqual(replacement.requestId, cancelled.requestId);
  assert.equal(replacement.sessionId, cancelled.sessionId);
  assert.equal(replacement.offset, 0);
  h.reply(cancelled, 'stale\n');
  assert.equal(h.store.details[key].status, 'loading');
  assert.equal(h.requests().length, 2);
  h.reply(replacement, 'replacement\n');
  h.reply(cancelled, 'stale\n');
  assert.equal(h.store.details[key].text, 'replacement\n');
  assert.equal(h.requests().length, 2, 'the cancelled generation cannot trigger a refresh of its replacement');
  assert.equal(Object.keys(h.store.pendingDetails).length, 0);
});

test('same-generation session handoff replays the active refresh without replaying its old trailing demand', async t => {
  const h = await fixture(t);
  h.seed('before\n');
  h.store.refreshDetail(kind, processId);
  const cancelled = h.latest();
  for (let i = 0; i < 5; i++) h.store.refreshDetail(kind, processId);
  h.replaceSession();
  const replay = h.latest();
  assert.equal(h.store.navigationGeneration, '7');
  assert.notEqual(replay.sessionId, cancelled.sessionId);
  assert.notEqual(replay.requestId, cancelled.requestId);
  assert.equal(replay.offset, byteLength('before\n'));
  assert.equal(h.requests().length, 2, 'the accepted handoff replays the one active detail request');
  h.reply(cancelled, 'stale\n');
  assert.equal(h.store.details[key].text, 'before\n');
  h.reply(replay, 'fresh\n');
  h.reply(cancelled, 'stale\n');
  assert.equal(h.store.details[key].text, 'before\nfresh\n');
  assert.equal(h.requests().length, 2, 'old pending demand cannot leak into the new session');
  assert.equal(Object.keys(h.store.pendingDetails).length, 0);
});

test('store reset drops pending mutable demand even when the same session and generation are reused', async t => {
  const h = await fixture(t);
  h.seed('old\n');
  h.store.refreshDetail(kind, processId);
  const cancelled = h.latest();
  h.store.refreshDetail(kind, processId);
  h.store.$reset();
  assert.equal(Object.keys(h.store.pendingDetails).length, 0);
  Object.assign(h.store, {
    sessionId: cancelled.sessionId, hostBootId: 'mutable-detail-host', navigationGeneration: '7',
    projections: { activeConversationWindow: { conversationId } }
  });
  h.seed('replacement\n');
  h.store.refreshDetail(kind, processId);
  const replacement = h.latest();
  h.reply(cancelled, 'stale\n');
  assert.equal(h.store.details[key].text, 'replacement\n');
  h.reply(replacement, 'current\n');
  h.reply(cancelled, 'stale\n');
  assert.equal(h.store.details[key].text, 'replacement\ncurrent\n');
  assert.equal(h.requests().length, 2, 'reset demand cannot trigger a trailing read in its replacement');
  assert.equal(Object.keys(h.store.pendingDetails).length, 0);
});

test('refresh failures retain complete text, exhaust three automatic retries and allow an explicit retry', async t => {
  const h = await fixture(t);
  const prefix = 'usable output\n';
  h.seed(prefix);
  h.store.refreshDetail(kind, processId);
  h.store.refreshDetail(kind, processId);
  h.fail(h.latest(), 'attempt 1 failed');
  assert.equal(h.requests().length, 1, 'failure does not consume dirty demand as an immediate trailing attempt');
  assert.equal(h.store.details[key].text, prefix);
  assert.equal(h.store.details[key].status, 'ready');
  for (const [index, delay] of [250, 750, 2_000].entries()) {
    h.runRetry(delay);
    assert.equal(h.requests().length, index + 2);
    assert.equal(h.latest().offset, byteLength(prefix), 'every retry starts at the last complete durable prefix');
    h.store.refreshDetail(kind, processId);
    h.fail(h.latest(), `attempt ${index + 2} failed`);
    assert.equal(h.requests().length, index + 2, 'a failed retry cannot bypass backoff by starting a trailing read');
    assert.equal(h.store.details[key].text, prefix);
  }
  assert.equal(h.store.details[key].status, 'ready');
  assert.equal(h.store.details[key].refreshError, 'attempt 4 failed');
  assert.equal(h.store.details[key].retryCount, 4);
  assert.deepEqual(h.retryDelays(), [], 'the three configured automatic retry admissions are exhausted');
  for (let i = 0; i < 5; i++) {
    h.store.requestDetail(kind, processId);
    h.store.refreshDetail(kind, processId);
  }
  assert.equal(h.requests().length, 4, 'ordinary visible demand cannot reset the exhausted retry budget');
  h.store.retryDetail(kind, processId, { priority: 'expanded' });
  assert.equal(h.requests().length, 5);
  assert.equal(h.latest().offset, byteLength(prefix));
  assert.equal(h.store.details[key].text, prefix);
  h.fail(h.latest(), 'manual attempt failed');
  assert.equal(h.store.details[key].retryCount, 1, 'explicit retry resets the failure budget');
  h.runRetry(250);
  assert.equal(h.requests().length, 6);
  h.reply(h.latest(), 'recovered\n');
  assert.equal(h.store.details[key].text, `${prefix}recovered\n`);
  assert.equal(h.store.details[key].refreshError, undefined);
  assert.equal(Object.keys(h.store.pendingDetails).length, 0);
  assert.deepEqual(h.retryDelays(), []);
});

test('permanent refresh errors retain the complete process output and never retry automatically or explicitly', async t => {
  const h = await fixture(t);
  h.seed('permanent retained output\n');
  h.store.refreshDetail(kind, processId);
  h.store.refreshDetail(kind, processId);
  h.fail(h.latest(), 'permanent output failure', false);
  assert.equal(h.store.details[key].status, 'ready');
  assert.equal(h.store.details[key].text, 'permanent retained output\n');
  assert.equal(h.store.details[key].refreshError, 'permanent output failure');
  assert.equal(h.store.details[key].terminalError, true);
  assert.equal(h.store.details[key].nextRetryAt, undefined);
  assert.deepEqual(h.retryDelays(), []);
  h.store.requestDetail(kind, processId);
  h.store.refreshDetail(kind, processId);
  h.store.retryDetail(kind, processId);
  assert.equal(h.requests().length, 1);
  assert.equal(Object.keys(h.store.pendingDetails).length, 0);
});

test('background process panel SSR retains output beside refresh errors and only explicit retry resets backoff', async t => {
  const scope = vue.effectScope();
  t.after(() => scope.stop());
  const h = await fixture(t, { panel: true });
  h.store.records.Process = {
    [processId]: {
      id: processId, status: 'exited', background_kind: 'requested', retained_bytes: '16',
      retained_chunks: '1', command_preview: 'echo retained',
      started_at: '2026-10-01T00:00:00.000Z', updated_at: '2026-10-01T00:00:01.000Z'
    }
  };
  h.store.records.ProcessOriginLink = { origin: { id: 'origin', process_id: processId, tool_call_id: 'call' } };
  const prefix = 'previous complete output';
  h.seed(prefix);
  Object.assign(h.store.details[key], { refreshError: 'refresh unavailable', retryCount: 4 });
  h.seed('', 'process-stderr');
  h.seed('{"command":"echo retained"}', 'tool-arguments-content', 'call');
  const app = vue.createSSRApp({});
  app.use(h.pinia);
  app.provide(vue.ssrContextKey, { modules: new Set() });
  const warnings = [];
  const originalWarn = console.warn;
  let state;
  try {
    console.warn = (...args) => warnings.push(args.join(' '));
    // Run actual setup outside SSR's watcher-suppression phase so automatic panel demands execute.
    state = app.runWithContext(() => scope.run(() => h.Panel.setup({}, { expose() {} })));
  } finally { console.warn = originalWarn; }
  assert.ok(warnings.every(warning => /onMounted.*no active component instance|onBeforeUnmount.*no active component instance/.test(warning)));
  state.open.value = true;
  await vue.nextTick();
  const stdoutRequests = () => h.requests().filter(request => request.kind === kind);
  for (let i = 0; i < 5; i++) state.ensureOutputDetails();
  assert.equal(stdoutRequests().length, 0, 'opening and automatic polling cannot reset an exhausted refresh budget');
  const render = () => {
    const renderedApp = vue.createSSRApp({ ...h.Panel, setup: () => state });
    renderedApp.use(h.pinia);
    return renderToString(renderedApp);
  };
  const html = await render();
  assert.match(html, /previous complete output/);
  assert.match(html, /标准输出读取失败：refresh unavailable/);
  assert.match(html, /已保留上次读到的输出/);
  assert.match(html, /<button[^>]*class="command-output-retry"[^>]*>重试读取<\/button>/);

  state.retryOutputDetail(kind);
  assert.equal(stdoutRequests().length, 1, 'the panel retry action explicitly admits another request');
  assert.equal(stdoutRequests()[0].offset, byteLength(prefix));
  h.fail(stdoutRequests()[0], 'permanent refresh failure', false);
  await vue.nextTick();
  const permanentHtml = await render();
  assert.match(permanentHtml, /previous complete output/);
  assert.match(permanentHtml, /permanent refresh failure/);
  assert.doesNotMatch(permanentHtml, /command-output-retry/);
  state.ensureOutputDetails();
  state.retryOutputDetail(kind);
  assert.equal(stdoutRequests().length, 1, 'a permanent error is not retried even through the explicit action');

  h.store.details[key] = { status: 'error', text: '', totalBytes: 0, error: 'initial load unavailable', retryCount: 4 };
  for (let i = 0; i < 5; i++) state.ensureOutputDetails();
  assert.equal(stdoutRequests().length, 1, 'automatic initial-load demand also preserves an exhausted budget');
  await vue.nextTick();
  assert.match(await render(), /标准输出读取失败：initial load unavailable/);
  state.retryOutputDetail(kind);
  assert.equal(stdoutRequests().length, 2);
  assert.equal(stdoutRequests().at(-1).offset, 0, 'explicit initial-load retry starts without a retained prefix');
});
