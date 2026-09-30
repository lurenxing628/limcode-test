import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createPinia, setActivePinia, disposePinia } from 'pinia';
import { createSSRApp, h } from 'vue';
import { renderToString } from 'vue/server-renderer';
import { createWebviewSsrServer } from './webview-ssr-server.mjs';

test('bootstrap binds Ready session, emits dirty before same-event send, and never certifies uninitialized data', async () => {
  const previousWindow = globalThis.window;
  const posted = [];
  const listeners = new Set();
  const timers = new Map();
  let nextTimer = 0;
  let persisted;
  globalThis.window = {
    addEventListener(name, listener) { if (name === 'message') listeners.add(listener); },
    removeEventListener(name, listener) { listeners.delete(listener); },
    setTimeout(callback) { const id = ++nextTimer; timers.set(id, callback); return id; },
    clearTimeout(id) { timers.delete(id); },
    acquireVsCodeApi() { return { postMessage(message) { posted.push(message); }, getState() { return persisted; }, setState(value) { persisted = value; } }; }
  };
  const server = await createWebviewSsrServer();
  const pinia = createPinia();
  setActivePinia(pinia);
  try {
    const { useBridgeBootstrap } = await server.ssrLoadModule('/src/composables/useBridgeBootstrap.ts');
    const { useGlobalSettingsStore } = await server.ssrLoadModule('/src/stores/useGlobalSettingsStore.ts');
    const { useSessionStore } = await server.ssrLoadModule('/src/stores/useSessionStore.ts');
    const { bridge, BridgeMessageType: types } = await server.ssrLoadModule('/src/transport/index.ts');
    const store = useGlobalSettingsStore();
    let sequence;
    const app = createSSRApp({ setup() {
      useBridgeBootstrap();
      // Keep mutations within the live synchronous SSR effect scope.
      const ready = posted.find(m => m.type === types.Ready);
      assert.ok(ready.payload.settingsActivitySessionId);
      assert.equal(posted.at(-1).payload.state, 'loading');
      store.applySnapshot({ section: 'llm', settings: { activeProviderConfigId: 'before' }, revision: 'disk-1', filePath: 'fixture' });
      assert.equal(posted.at(-1).payload.state, 'clean');
      const begin = posted.length;
      store.llm.activeProviderConfigId = 'after';
      bridge.request(types.TurnStart, { conversationId: 'c', command: { commandId: 'send' }, text: 'fixture' });
      sequence = posted.slice(begin);
      // The settings view compares catalogs too. Unrelated/nested UI actions must reuse its
      // computed fence rather than repeatedly walking and serializing those catalogs.
      useSessionStore().viewKind = 'globalSettings';
      store.applySnapshot({ section: 'llm', settings: { activeProviderConfigId: 'after' }, revision: 'disk-2', filePath: 'fixture' });
      store.applySnapshot({ section: 'llmProviderConfigs', settings: { configs: [] }, revision: 'providers-0', filePath: 'fixture' });
      store.applySnapshot({ section: 'llmCompressionConfigs', settings: { configs: [] }, revision: 'compression-configs-0', filePath: 'fixture' });
      store.applySnapshot({ section: 'llmCompression', settings: JSON.parse(JSON.stringify(store.llmCompression)), revision: 'compression-0', filePath: 'fixture' });
      assert.equal(posted.at(-1).payload.state, 'clean');
      let contentChecks = 0;
      const stopCounting = store.$onAction(({ name }) => { if (name === 'executionSaveState') contentChecks++; });
      for (let i = 0; i < 100; i++) store.closeFetchedModelsDialog();
      assert.equal(contentChecks, 0, 'unrelated actions must not recompute the content fence');
      stopCounting();
      return () => h('div');
    } });
    app.use(pinia);
    await renderToString(app);
    assert.equal(sequence[0].type, types.GlobalSettingsActivity);
    assert.equal(sequence[0].payload.state, 'dirty');
    assert.equal(sequence[1].type, types.TurnStart);
    assert.deepEqual(Object.keys(sequence[0].payload).sort(), ['revision', 'sessionId', 'state']);
    assert.ok(sequence[0].payload.revision > posted.find(m => m.type === types.GlobalSettingsActivity).payload.revision);
    // The host path requires initialized sections; no early saved ACK before the first snapshot.
    let done = false;
    delete store.loadedSections.llmProviderConfigs;
    const flushing = store.flushForExecution(['llmProviderConfigs'], true).then(() => { done = true; });
    await Promise.resolve();
    assert.equal(done, false);
    store.applySnapshot({ section: 'llmProviderConfigs', settings: { configs: [] }, revision: 'providers-1', filePath: 'fixture' });
    await flushing;
  } finally {
    disposePinia(pinia);
    await server.close();
    if (previousWindow === undefined) delete globalThis.window; else globalThis.window = previousWindow;
  }
});
