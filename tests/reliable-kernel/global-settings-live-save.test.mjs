import assert from 'node:assert/strict';
import path from 'node:path';
import { createRequire } from 'node:module';
import test from 'node:test';
import { createServer } from 'vite';
import { createPinia, setActivePinia } from 'pinia';
import { createSSRApp, h } from 'vue';
import { renderToString } from 'vue/server-renderer';

const require = createRequire(import.meta.url);
const protocol = require('../../dist/extension/shared/protocol.js');
const { GlobalSettingsSaveBarrier } = require('../../dist/extension/backend/application/reliableKernel/GlobalSettingsSaveBarrier.js');
const section = 'llmCompressionConfigs';

async function withStore(run) {
  const previousWindow = globalThis.window;
  const posted = [];
  const timers = new Map();
  let nextId = 0;
  let now = 0;
  let persisted;
  globalThis.window = {
    addEventListener() {}, removeEventListener() {},
    setTimeout(callback, delay) { const id = ++nextId; timers.set(id, { callback, at: now + delay }); return id; },
    clearTimeout(id) { timers.delete(id); },
    acquireVsCodeApi() { return { postMessage(message) { posted.push(message); }, getState() { return persisted; }, setState(value) { persisted = value; } }; }
  };
  const server = await createServer({ configFile: path.join(process.cwd(), 'vite.config.ts'), server: { middlewareMode: true }, appType: 'custom', logLevel: 'error' });
  try {
    const { useGlobalSettingsStore } = await server.ssrLoadModule('/src/stores/useGlobalSettingsStore.ts');
    const pinia = createPinia();
    setActivePinia(pinia);
    const store = useGlobalSettingsStore();
    const config = { ...protocol.createDefaultLlmCompressionConfig('保存测试'), trigger: { mode: 'token_threshold', thresholdUnit: 'tokens', thresholdTokens: 120000 } };
    const initial = { section, settings: { configs: [config] }, filePath: 'fixture', revision: 'initial' };
    store.applySnapshot(initial);
    const writes = () => posted.filter((message) => message.type === protocol.BridgeMessageType.GlobalSettingsUpdate && message.payload.section === section);
    const reads = () => posted.filter((message) => message.type === protocol.BridgeMessageType.GlobalSettingsGet && message.payload.section === section);
    const edit = (value) => { store.llmCompressionConfigs.configs[0].trigger.thresholdTokens = value; store.llmCompressionConfigs.configs[0].updatedAt = Date.now(); store.queueLlmCompressionConfigsAutoSave(); };
    const ack = (write, revision = `saved-${write.id}`) => store.applySnapshot({ ...initial, revision, settings: write.payload.settings }, write.id);
    const advance = async (ms) => {
      const target = now + ms;
      for (;;) {
        const next = [...timers].filter(([, timer]) => timer.at <= target).sort((a, b) => a[1].at - b[1].at)[0];
        if (!next) break;
        now = next[1].at;
        timers.delete(next[0]);
        next[1].callback();
        await Promise.resolve();
      }
      now = target;
    };
    let deadline;
    try {
      await Promise.race([
        run({ store, initial, writes, reads, edit, ack, advance, timers, posted, server, pinia }),
        new Promise((_, reject) => { deadline = setTimeout(() => reject(new Error(`测试等待未结束：${JSON.stringify({
          writes: writes().length,
          pending: store.pendingSettingsSections,
          errors: store.failedSettingsSections,
          config: store.llmCompressionConfigs,
          baseline: store.baselines[section]
        })}`)), 5000); })
      ]);
    } finally { clearTimeout(deadline); }
  } finally {
    await server.close();
    if (previousWindow === undefined) delete globalThis.window;
    else globalThis.window = previousWindow;
  }
}

function providerFixture(requestBody = {}) {
  return {
    id: 'provider', name: '渠道', provider: 'openai-responses', model: 'model', models: [{ id: 'model', name: '模型' }],
    apiKey: '', baseUrl: 'https://example.invalid', toolCallFormat: 'function-call', stream: true,
    contextWindowTokens: 200000, generationConfig: {}, headers: {}, requestBody, modelConfigs: [], createdAt: 1, updatedAt: 1
  };
}

test('发送前立即提交尚在延迟中的修改，连续修改全部确认后才放行', async () => {
  await withStore(async ({ store, writes, edit, ack }) => {
    edit(40000);
    assert.equal(writes().length, 0);
    let finished = false;
    const flushing = store.flushForExecution().then(() => { finished = true; });
    assert.equal(writes().length, 1);
    edit(50000);
    store.saveLlmCompressionConfigs();
    ack(writes()[0]);
    await Promise.resolve();
    assert.equal(finished, false);
    assert.equal(writes().length, 2);
    assert.equal(writes()[1].payload.settings.configs[0].trigger.thresholdTokens, 50000);
    ack(writes()[1]);
    await flushing;
    assert.equal(finished, true);
  });
});

test('压缩配置的数据转换不制造新的修改时间，保存确认后不会再次保存', async () => {
  await withStore(async ({ store, edit, writes, ack, advance }) => {
    edit(40000);
    await advance(400);
    const saved = writes()[0];
    await new Promise((resolve) => setTimeout(resolve, 10));
    ack(saved);
    assert.equal(writes().length, 1);
    await new Promise((resolve) => setTimeout(resolve, 10));
    await store.flushForExecution();
    assert.equal(writes().length, 1);
    assert.equal(store.llmCompressionConfigs.configs[0].updatedAt, saved.payload.settings.configs[0].updatedAt);
  });
});

test('渠道默认字段补齐不算未保存修改，未编辑时可以直接确认', async () => {
  await withStore(async ({ store, initial, writes }) => {
    const provider = providerFixture();
    for (const [section, settings] of Object.entries({
      llmProviderConfigs: { configs: [provider] }, llm: { activeProviderConfigId: provider.id },
      llmCompression: { defaultConfigId: initial.settings.configs[0].id, providerBindings: [], modelBindings: [] }
    })) store.applySnapshot({ section, settings, filePath: 'fixture', revision: 'initial' });
    await store.flushForExecution();
    assert.equal(writes().length, 0);
  });
});

test('多条压缩配置载入后不算未保存修改，第二条起的阈值不被下标污染', async () => {
  await withStore(async ({ store, writes }) => {
    // 归一化函数的第二个形参是上下文窗口大小，直接把它交给 map 会收到数组下标，
    // 于是第二条起的配置按「窗口只有 1、2 个 Token」重算阈值，和基线永远对不上。
    const configs = ['第一个', '第二个', '第三个'].map((name) => protocol.createDefaultLlmCompressionConfig(name));
    store.applySnapshot({ section, settings: { configs }, filePath: 'fixture', revision: 'multi' });
    const baseline = store.baselines[section];
    store.llmCompressionConfigs.configs.forEach((config, index) => {
      assert.deepEqual(config.trigger, baseline.configs[index].trigger);
    });
    await store.flushForExecution();
    assert.equal(writes().length, 0);
  });
});

test('保存比较只忽略记录元数据，不忽略用户自定义参数中同名时间字段的冲突', async () => {
  await withStore(async ({ store, posted }) => {
    const section = 'llmProviderConfigs';
    const initial = {
      section, settings: { configs: [providerFixture({ configs: [{ id: 'custom', updatedAt: 1 }] })] },
      filePath: 'fixture', revision: 'initial'
    };
    store.applySnapshot(initial);
    store.llmProviderConfigs.configs[0].requestBody.configs[0].updatedAt = 2;
    store.saveLlmProviderConfigs();
    const write = posted.find((message) => message.type === protocol.BridgeMessageType.GlobalSettingsUpdate && message.payload.section === section);
    const external = structuredClone(initial);
    external.revision = 'external';
    external.settings.configs[0].requestBody.configs[0].updatedAt = 3;
    store.applySnapshot(external);
    store.setError('修订冲突', { section, code: 'settings_revision_conflict', correlationId: write.id });
    assert.equal(store.llmProviderConfigs.configs[0].requestBody.configs[0].updatedAt, 2);
    await assert.rejects(store.flushForExecution(), /其他窗口/);
    store.applyExternalSettingsChange(section);
    assert.equal(store.llmProviderConfigs.configs[0].requestBody.configs[0].updatedAt, 3);
    await store.flushForExecution();
  });
});

test('对话提示实时显示当前压缩配置，最近请求采用值仍保持原值', async () => {
  await withStore(async ({ store, initial, server, pinia }) => {
    const { useReliableKernelClientFeedStore } = await server.ssrLoadModule('/src/stores/useReliableKernelClientFeedStore.ts');
    const { default: ContextStatus } = await server.ssrLoadModule('/src/components/conversation/ReliableContextStatus.vue');
    const feed = useReliableKernelClientFeedStore();
    feed.projections = { activeConversationWindow: { conversationId: 'conversation' } };
    feed.records = {
      Turn: { turn: { id: 'turn', conversation_id: 'conversation' } },
      ModelRequest: { request: {
        id: 'request', turn_id: 'turn', provider_id: 'provider', model_id: 'model',
        context_window_tokens: 200000, compression_threshold_tokens: 120000, request_seq: '1'
      } },
      ModelRequestMessageLink: { link: { model_request_id: 'request' } }
    };
    store.applySnapshot({ section: 'llmProviderConfigs', settings: { configs: [providerFixture()] }, filePath: 'fixture', revision: 'initial' });
    store.llmCompression.defaultConfigId = initial.settings.configs[0].id;
    const config = store.llmCompressionConfigs.configs[0];
    config.trigger.thresholdTokens = 40000;
    let status;
    await renderToString(createSSRApp({
      setup() {
        status = ContextStatus.setup({}, { expose() {} });
        return () => h('div');
      }
    }).use(pinia));
    const row = (label) => status.tooltipRows.value.find((item) => item.label === label).value;
    assert.equal(row('当前配置压缩阈值'), '40,000 Token');
    assert.equal(row('最近请求采用阈值'), '120,000 Token');
    config.trigger.thresholdUnit = 'percent';
    config.trigger.thresholdPercent = 30;
    assert.equal(row('当前配置压缩阈值'), '60,000 Token');
    config.trigger.mode = 'manual';
    assert.equal(row('当前配置压缩阈值'), '仅手动压缩');
    config.kind = 'disabled';
    assert.equal(row('当前配置压缩阈值'), '已关闭');
    assert.equal(row('最近请求采用阈值'), '120,000 Token');
  });
});

test('保存确认丢失时读取磁盘核对，并保留排队中的较新修改', async () => {
  await withStore(async ({ store, initial, writes, reads, edit, ack, advance }) => {
    edit(40000);
    await advance(400);
    const first = writes()[0];
    edit(50000);
    await advance(400);
    await advance(4600);
    assert.equal(reads().length, 1);
    const committed = structuredClone(first.payload.settings);
    committed.configs[0].updatedAt += 1000;
    store.applySnapshot({ ...initial, revision: 'saved-first', settings: committed }, reads()[0].id);
    assert.equal(writes().length, 2);
    assert.equal(writes()[1].payload.settings.configs[0].trigger.thresholdTokens, 50000);
    const waiting = store.flushForExecution();
    ack(writes()[1]);
    await waiting;
    ack(first, 'saved-first');
    assert.equal(store.llmCompressionConfigs.configs[0].trigger.thresholdTokens, 50000);
  });
});

test('核对发现原保存未提交时重新发送当前内容，迟到回应不能覆盖新状态', async () => {
  await withStore(async ({ store, initial, writes, reads, edit, ack, advance }) => {
    edit(40000);
    await advance(400);
    const first = writes()[0];
    edit(50000);
    await advance(5000);
    store.applySnapshot(initial, reads()[0].id);
    assert.equal(writes().length, 2);
    assert.equal(writes()[1].payload.expectedRevision, 'initial');
    ack(writes()[1]);
    ack(first);
    assert.equal(store.llmCompressionConfigs.configs[0].trigger.thresholdTokens, 50000);
    assert.equal(store.pendingSettingsSections[section], undefined);
  });
});

test('先收到新设置再收到冲突通知，也能合并不相交的修改并继续保存', async () => {
  await withStore(async ({ store, initial, writes, edit, advance, ack }) => {
    edit(40000);
    await advance(400);
    const first = writes()[0];
    const external = structuredClone(initial);
    external.revision = 'external';
    external.settings.configs[0].name = '另一窗口改名';
    external.settings.configs[0].updatedAt += 500;
    store.applySnapshot(external);
    store.setError('修订冲突', { section, code: 'settings_revision_conflict', correlationId: first.id });
    assert.equal(writes().length, 2);
    assert.equal(writes()[1].payload.settings.configs[0].name, '另一窗口改名');
    assert.equal(writes()[1].payload.settings.configs[0].trigger.thresholdTokens, 40000);
    ack(writes()[1]);
    await store.flushForExecution();
  });
});

test('同字段冲突停止等待并保留两侧内容，用户选择后才能继续', async () => {
  await withStore(async ({ store, initial, writes, edit, advance, ack }) => {
    edit(40000);
    await advance(400);
    const first = writes()[0];
    const external = structuredClone(initial);
    external.revision = 'external';
    external.settings.configs[0].trigger.thresholdTokens = 60000;
    store.applySnapshot(external);
    store.setError('修订冲突', { section, code: 'settings_revision_conflict', correlationId: first.id });
    assert.equal(store.pendingSettingsSections[section], undefined);
    assert.equal(store.llmCompressionConfigs.configs[0].trigger.thresholdTokens, 40000);
    await assert.rejects(store.flushForExecution(), /其他窗口/);
    store.dismissExternalSettingsChange(section);
    assert.equal(writes().length, 2);
    assert.equal(writes()[1].payload.expectedRevision, 'external');
    ack(writes()[1]);
    await store.flushForExecution();
  });
});

test('其他窗口撤回冲突后自动继续保存，不残留已解除的暂停状态', async () => {
  await withStore(async ({ store, initial, writes, edit, advance, ack }) => {
    edit(40000);
    await advance(400);
    const external = structuredClone(initial);
    external.revision = 'external';
    external.settings.configs[0].trigger.thresholdTokens = 60000;
    store.applySnapshot(external);
    store.setError('修订冲突', { section, code: 'settings_revision_conflict', correlationId: writes()[0].id });
    await assert.rejects(store.flushForExecution(), /其他窗口/);
    store.applySnapshot({ ...initial, revision: 'external-reverted' });
    assert.equal(writes().length, 2);
    assert.equal(writes()[1].payload.expectedRevision, 'external-reverted');
    assert.equal(writes()[1].payload.settings.configs[0].trigger.thresholdTokens, 40000);
    ack(writes()[1]);
    await store.flushForExecution();
  });
});

test('保存和核对回应都丢失时有界报错，重新读取不会清掉未保存修改', async () => {
  await withStore(async ({ store, initial, reads, writes, edit, ack, advance }) => {
    edit(40000);
    await advance(10400);
    assert.equal(store.pendingSettingsSections[section], undefined);
    assert.match(store.failedSettingsSections[section], /本地修改已保留/);
    await assert.rejects(store.flushForExecution(), /本地修改已保留/);
    store.requestAll();
    assert.equal(store.llmCompressionConfigs.configs[0].trigger.thresholdTokens, 40000);
    store.applySnapshot(initial, reads().at(-1).id);
    assert.equal(writes().length, 2);
    ack(writes()[1]);
    assert.equal(store.failedSettingsSections[section], undefined);
  });
});

test('重新读取时保留尚在自动保存延迟中的表单', async () => {
  await withStore(async ({ store, initial, edit, advance, writes }) => {
    edit(40000);
    store.requestAll();
    store.applySnapshot(initial);
    assert.equal(store.llmCompressionConfigs.configs[0].trigger.thresholdTokens, 40000);
    await advance(400);
    assert.equal(writes()[0].payload.settings.configs[0].trigger.thresholdTokens, 40000);
  });
});

test('跨页面保存确认必须等待所有页面，错误编号和重复回应不能提前放行', async () => {
  const barrier = new GlobalSettingsSaveBarrier(1000);
  const messages = [];
  for (const id of ['settings', 'chat']) barrier.attach(id, { async postMessage(message) { messages.push([id, message]); return true; } });
  let done = false;
  const flushing = barrier.flush().then(() => { done = true; });
  await Promise.resolve();
  const id = messages[0][1].id;
  barrier.receive('other', id, { status: 'saved' });
  barrier.receive('settings', 'wrong', { status: 'saved' });
  barrier.receive('settings', id, { status: 'saved' });
  barrier.receive('settings', id, { status: 'saved' });
  await Promise.resolve();
  assert.equal(done, false);
  barrier.receive('chat', id, { status: 'saved' });
  await flushing;
  assert.equal(done, true);
});

test('跨页面确认遇到冲突、关闭、发送失败或超时均明确拒绝', async () => {
  for (const failure of ['conflict', 'closed', 'undelivered', 'timeout']) {
    const barrier = new GlobalSettingsSaveBarrier(20);
    let message;
    barrier.attach('settings', { async postMessage(value) { message = value; return failure !== 'undelivered'; } });
    const flushing = barrier.flush();
    const rejected = assert.rejects(flushing, /设置|页面/);
    await Promise.resolve();
    if (failure === 'conflict') barrier.receive('settings', message.id, { status: 'failed', message: '设置冲突' });
    if (failure === 'closed') barrier.detach('settings');
    await rejected;
  }
});
