import assert from 'node:assert/strict';
import test from 'node:test';
import { createWebviewSsrServer } from './webview-ssr-server.mjs';

test('压缩最长时间输入块位于阈值之后，手动压缩也可设置', async () => {
  const server = await createWebviewSsrServer();
  try {
    const { default: editor } = await server.ssrLoadModule('/src/components/settings/global/LlmCompressionSettingsEditor.vue');
    const { createSSRApp } = await import('vue');
    const { renderToString } = await import('@vue/server-renderer');
    for (const mode of ['manual', 'token_threshold']) {
      const html = await renderToString(createSSRApp(editor, {
        config: { id: 'duration', kind: 'llm_summary', trigger: { mode }, maxDurationMinutes: 37 },
        providerConfigs: [], contextWindowTokens: 250000
      }));
      const input = html.match(/<input[^>]*aria-label="单次压缩最长时间（分钟）"[^>]*>/)[0];
      assert.match(input, /value="37"/);
      assert.match(input, /min="1"/);
      assert.match(input, /max="1440"/);
      if (mode === 'token_threshold') {
        assert.ok(html.indexOf('单次压缩最长时间') > html.indexOf('完整输入 Token 触发阈值'));
      }
    }
  } finally {
    await server.close();
  }
});

test('渠道和模型的压缩时长独立保存，序列化与重新加载不丢值', async (context) => {
  const server = await createWebviewSsrServer();
  const previousWindow = globalThis.window;
  globalThis.window = {
    addEventListener() {}, removeEventListener() {},
    setTimeout, clearTimeout,
    acquireVsCodeApi() { return { postMessage() {}, getState() {}, setState() {} }; }
  };
  const pinia = await import('pinia');
  const previousPinia = pinia.getActivePinia();
  try {
    const { useGlobalSettingsStore } = await server.ssrLoadModule('/src/stores/useGlobalSettingsStore.ts');
    pinia.setActivePinia(pinia.createPinia());
    const store = useGlobalSettingsStore();
    const updates = [];
    context.mock.method(store, 'enqueueSettingsUpdate', (payload) => updates.push(structuredClone(payload)));
    context.mock.method(store, 'queueLlmCompressionConfigsAutoSave', () => {});
    store.llmProviderConfigs = { configs: [{
      id: 'duration-provider', name: 'duration provider', provider: 'openai-compatible',
      model: 'duration-model', models: [{ id: 'duration-model', name: 'duration model' }],
      modelConfigs: [], contextWindowTokens: 250000
    }] };
    store.llm = { activeProviderConfigId: 'duration-provider' };
    store.llmCompressionConfigs = { configs: [{
      id: 'shared-duration', name: 'shared', kind: 'llm_summary', maxDurationMinutes: 20,
      trigger: { mode: 'manual' }, createdAt: 1, updatedAt: 1
    }] };
    store.llmCompression = { defaultConfigId: 'shared-duration', providerBindings: [], modelBindings: [] };
    store.setActiveCompressionMaxDurationMinutes(37);
    assert.equal(store.activeCompressionConfig.maxDurationMinutes, 37);
    assert.notEqual(store.activeCompressionConfig.id, 'shared-duration');
    assert.equal(store.llmCompressionConfigs.configs.find((config) => config.id === 'shared-duration').maxDurationMinutes, 20);
    const providerConfigId = store.activeCompressionConfig.id;
    store.setModelCompressionMaxDurationMinutes('duration-model', 45);
    const modelConfig = store.compressionConfigForActiveModel('duration-model');
    assert.equal(modelConfig.maxDurationMinutes, 45);
    assert.notEqual(modelConfig.id, providerConfigId);
    assert.equal(store.activeCompressionConfig.maxDurationMinutes, 37);
    store.saveLlmCompressionConfigs();
    const saved = updates.filter((update) => update.section === 'llmCompressionConfigs').at(-1).settings;
    assert.equal(saved.configs.find((config) => config.id === providerConfigId).maxDurationMinutes, 37);
    assert.equal(saved.configs.find((config) => config.id === modelConfig.id).maxDurationMinutes, 45);
    store.applySectionSettings('llmCompressionConfigs', JSON.parse(JSON.stringify(saved)));
    assert.equal(store.activeCompressionConfig.maxDurationMinutes, 37);
    assert.equal(store.compressionConfigForActiveModel('duration-model').maxDurationMinutes, 45);
  } finally {
    pinia.setActivePinia(previousPinia);
    if (previousWindow === undefined) delete globalThis.window;
    else globalThis.window = previousWindow;
    await server.close();
  }
});
