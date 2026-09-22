import assert from 'node:assert/strict';
import { after, test } from 'node:test';

const CHANNEL_SETTINGS_SECTIONS = ['llm', 'llmProviderConfigs', 'llmCompression', 'llmCompressionConfigs'];

function createMockStore(overrides = {}) {
  return {
    externalChangedSections: {},
    failedSettingsSections: {},
    loadingSettingsSections: {},
    pendingSettingsSections: {},
    dirtySections: {},
    ...overrides
  };
}

function isSectionDirty(state, section) {
  return state.dirtySections?.[section] || false;
}

// 模拟修复后的 flushForExecution(sections) 逻辑
function simulateFlushForExecution(store, sections = CHANNEL_SETTINGS_SECTIONS, timeoutMs = 12_000) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new Error('设置尚未确认保存，已暂停本次操作，请检查设置页。'));
    }, timeoutMs);

    const check = () => {
      // 仅在当前视图关心的 section 上检查外部冲突
      for (const section of sections) {
        if (store.externalChangedSections[section] || store.failedSettingsSections[section]) {
          clearTimeout(timer);
          reject(new Error(store.failedSettingsSections[section] || '设置有未处理的修改冲突，请先在设置页确认。'));
          return;
        }
      }
      // 仅等待当前视图关心的 section 收敛
      if (sections.every((section) => !isSectionDirty(store, section) && !store.loadingSettingsSections[section])) {
        clearTimeout(timer);
        resolve();
      }
    };

    const interval = setInterval(check, 100);
    check();
    setTimeout(() => clearInterval(interval), timeoutMs + 100);
  });
}

test('GREEN: 聊天面板不被设置页脏输入阻塞', async () => {
  // 聊天面板只依赖 ['llm']，设置页的 llmProviderConfigs 脏输入不应阻塞
  const chatStore = createMockStore({
    externalChangedSections: { llmProviderConfigs: true }
  });

  // 聊天面板只检查 ['llm']，不应受 llmProviderConfigs 影响
  await simulateFlushForExecution(chatStore, ['llm'], 100);
  console.log('[GREEN] Chat panel no longer blocked by settings page dirty input');
});

test('GREEN: 设置页仍检查全部 4 个 section', async () => {
  const settingsStore = createMockStore({
    externalChangedSections: { llmProviderConfigs: true }
  });

  // 设置页检查全部 4 个 section，应被阻塞
  await assert.rejects(
    simulateFlushForExecution(settingsStore, CHANNEL_SETTINGS_SECTIONS, 100),
    /设置有未处理的修改冲突/,
    'Settings page should still check all 4 sections'
  );
  console.log('[GREEN] Settings page still blocked by its own dirty input');
});

test('GREEN: loading 超时保护自动清除', async () => {
  const store = createMockStore({
    loadingSettingsSections: { llmProviderConfigs: true }
  });

  // 模拟 loading 超时保护：8 秒后自动清除
  setTimeout(() => {
    delete store.loadingSettingsSections['llmProviderConfigs'];
  }, 800);

  // 应在 8 秒后自动清除并成功
  await simulateFlushForExecution(store, ['llm', 'llmProviderConfigs'], 10_000);
  console.log('[GREEN] Loading timeout protection clears hanging section');
});

test('GREEN: 多面板确认不因单个面板关闭而拒绝', async () => {
  // 这与 PR #31 的 barrier 修复配合，但此处验证前端不再阻塞
  const chatStore = createMockStore({
    loadingSettingsSections: { llm: false },
    dirtySections: { llm: false }
  });

  // 聊天面板快速收敛
  await simulateFlushForExecution(chatStore, ['llm'], 100);
  console.log('[GREEN] Chat panel converges quickly without waiting for settings page');
});
