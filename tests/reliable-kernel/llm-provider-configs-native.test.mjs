import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { after, test } from 'node:test';

const require = createRequire(import.meta.url);
const Module = require('node:module');
const originalLoad = Module._load;
Module._load = function load(request, parent, isMain) {
  if (request === 'vscode') return {};
  return originalLoad.call(this, request, parent, isMain);
};
after(() => { Module._load = originalLoad; });

const {
  normalizeLlmProviderConfig
} = require('../../dist/extension/backend/capabilities/vscodeStorage/llmProviderConfigs.js');


test('nativeResponses is normalized to known boolean flags and survives save/load normalization', () => {
  const normalized = normalizeLlmProviderConfig({
    name: 'Astra',
    provider: 'openai-responses',
    nativeResponses: {
      enabled: true,
      asyncTools: false,
      steering: true,
      reasoningUpdates: 'yes',
      multiplexing: true,
      unknownFutureFlag: true
    }
  });
  assert.deepEqual(normalized.nativeResponses, {
    enabled: true,
    asyncTools: false,
    steering: true,
    multiplexing: true
  }, '非布尔值与未知键必须被剔除，布尔多路复用按原值保留');
  const roundTripped = normalizeLlmProviderConfig(normalized);
  assert.deepEqual(roundTripped.nativeResponses, normalized.nativeResponses, '二次归一化必须稳定');
});

test('explicit enabled=false is preserved because it doubles as a relay support decision', () => {
  const normalized = normalizeLlmProviderConfig({
    name: 'Relay',
    provider: 'openai-responses',
    nativeResponses: { enabled: false }
  });
  assert.deepEqual(normalized.nativeResponses, { enabled: false });
});

test('empty or invalid nativeResponses is omitted instead of persisted as a hollow object', () => {
  for (const nativeResponses of [{}, 'enabled', 7, null, ['enabled']]) {
    const normalized = normalizeLlmProviderConfig({ name: 'Astra', provider: 'openai-responses', nativeResponses });
    assert.equal('nativeResponses' in normalized, false, `nativeResponses=${JSON.stringify(nativeResponses)}`);
  }
});

test('per-model nativeResponses is normalized and inherits nothing implicitly', () => {
  const normalized = normalizeLlmProviderConfig({
    name: 'Astra',
    provider: 'openai-responses',
    model: 'gpt-6-astra',
    models: [{ id: 'gpt-6-astra', name: 'gpt-6-astra' }],
    nativeResponses: { enabled: true, steering: true },
    modelConfigs: [{
      modelId: 'gpt-6-astra',
      nativeResponses: { enabled: true, reasoningUpdates: false, bogus: 'x' }
    }]
  });
  assert.equal(normalized.modelConfigs.length, 1);
  assert.deepEqual(normalized.modelConfigs[0]?.nativeResponses, {
    enabled: true,
    reasoningUpdates: false
  });
  // 模型级未设置时不得从渠道级隐式继承——继承只发生在创建模型配置的显式复制路径。
  const withoutModelNative = normalizeLlmProviderConfig({
    name: 'Astra',
    provider: 'openai-responses',
    model: 'gpt-6-astra',
    models: [{ id: 'gpt-6-astra', name: 'gpt-6-astra' }],
    nativeResponses: { enabled: true },
    modelConfigs: [{ modelId: 'gpt-6-astra' }]
  });
  assert.equal('nativeResponses' in (withoutModelNative.modelConfigs[0] ?? {}), false);
});


test('强制重试默认关闭，渠道与模型按各自完整配置保存，不隐式继承', () => {
  assert.equal(normalizeLlmProviderConfig({}).retryForceAllErrors, false);
  const provider = normalizeLlmProviderConfig({ name: 'force', retryForceAllErrors: true,
    models: [{ id: 'on', name: 'on' }, { id: 'off', name: 'off' }, { id: 'unset', name: 'unset' }],
    modelConfigs: [{ modelId: 'on', retryForceAllErrors: true }, { modelId: 'off', retryForceAllErrors: false }, { modelId: 'unset' }]
  });
  assert.equal(provider.retryForceAllErrors, true);
  assert.deepEqual(Object.fromEntries(provider.modelConfigs.map(m => [m.modelId, m.retryForceAllErrors])),
    { off: false, on: true, unset: false });
  const saved = normalizeLlmProviderConfig(JSON.parse(JSON.stringify(provider)));
  assert.equal(saved.retryForceAllErrors, true);
  assert.deepEqual(saved.modelConfigs, provider.modelConfigs);
});
