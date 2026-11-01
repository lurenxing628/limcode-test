import assert from 'node:assert/strict';
import { before, after, test } from 'node:test';
import { mkdir } from 'node:fs/promises';
import path from 'node:path';
import { chromium } from 'playwright';
import { createBrowserFixtureServer } from './reliable-kernel/browser-fixture-server.mjs';

const longId = 'gpt-6-astra-' + 'long-model-identifier-'.repeat(5);
const entry = `
import { createApp, h, reactive, ref } from 'vue';
import { createPinia } from 'pinia';
import Panel from '/src/components/settings/GlobalSettingsPanel.vue';
import ModelProfileScopeEditor from '/src/components/settings/config/ModelProfileScopeEditor.vue';
import InputPanel from '/src/components/ui/InputPanel.vue';
import { useGlobalSettingsStore } from '/src/stores/useGlobalSettingsStore';
import { useClientStateStore } from '/src/stores/useClientStateStore';
import { useModelProfileStore } from '/src/stores/useModelProfileStore';
import { useBridgeBootstrap } from '/src/composables/useBridgeBootstrap';
import builtInSound from '/src/assets/task-complete.wav';
import { GLOBAL_SETTINGS_SECTIONS, createDefaultLlmCompressionConfig } from '@shared/protocol';
import '/src/theme/tokens.css'; import '/src/theme/base.css';
import '/src/theme/motion/dialog.css'; import '/src/theme/motion/dropdown.css'; import '/src/theme/motion/collapse.css';
const pinia = createPinia(), mode = ref('settings'), confirmed = [];
const inputProps = reactive({ open: true, title: '名称校验', label: '名称', initialValue: 'duplicate', required: true,
  validate: value => value === 'duplicate' ? '名称已存在' : '' });
const app = createApp({ setup: () => () => mode.value === 'settings' ? h(Panel)
  : mode.value === 'soundChat' ? h(SoundChat)
  : mode.value === 'model' ? h(ModelProfileScopeEditor, { scopeKind: 'agent', scopeId: 'worker', title: 'Agent 默认 LLM' }) : h(InputPanel, {
  ...inputProps, onConfirm: value => confirmed.push(value), onCancel: () => inputProps.open = false }) });
app.use(pinia);
const settings = useGlobalSettingsStore(pinia), client = useClientStateStore(pinia);
client.configurationReady = true;
const provider = { id: 'provider', name: '测试渠道', provider: 'openai-responses', model: 'gpt-6-astra',
  baseUrl: 'https://api.openai.com/v1', apiKey: '', stream: true, contextWindowTokens: 200000,
  generationConfig: {}, requestBody: {}, headers: {}, modelConfigs: [],
  models: [{ id: 'gpt-6-astra', name: 'GPT-6 Astra' }, { id: ${JSON.stringify(longId)}, name: ${JSON.stringify(longId)} }] };
const compression = { ...createDefaultLlmCompressionConfig('默认压缩配置'), id: 'compression' };
const seed = { llm: { activeProviderConfigId: 'provider' }, llmProviderConfigs: { configs: [provider] },
  llmCompression: { defaultConfigId: 'compression', providerBindings: [], modelBindings: [] }, llmCompressionConfigs: { configs: [compression] } };
for (const section of GLOBAL_SETTINGS_SECTIONS) settings.applySnapshot({ section,
  settings: seed[section] ?? JSON.parse(JSON.stringify(settings[section])), revision: 'fixture:' + section, filePath: 'memory-only' });
client.toolDefinitions = [{ id: 'edit', name: 'edit', description: '修改文件内容', parameters: {}, execution: 'immediate', source: { kind: 'builtin' } }];
client.toolPolicies = [{ id: 'policy', name: '测试策略', preset: 'custom', allowedTools: ['edit'], toolConfigs: { edit: { autoSubmitResult: false, config: {} } } }];
client.toolPolicyScopeLinks = [{ id: 'link', scopeKind: 'global', toolPolicyId: 'policy', role: 'active', createdAt: 1, updatedAt: 1 }];
const SoundChat = { setup() { useBridgeBootstrap(); return () => h('div', 'sound chat'); } };
window.fixture = { settings, client, mode, inputProps, confirmed, builtInSound, models: useModelProfileStore(pinia) };
app.mount('#app');
`;
const theme = `:root {
  --vscode-font-family: 'Noto Sans CJK SC', sans-serif;
  --vscode-editor-background: #1f1f1f; --vscode-foreground: #cccccc; --vscode-descriptionForeground: #9d9d9d;
  --vscode-panel-border: #3c3c3c; --vscode-sideBar-background: #181818; --vscode-editorWidget-background: #252526;
  --vscode-input-background: #313131; --vscode-input-foreground: #cccccc; --vscode-input-border: #3c3c3c;
  --vscode-input-placeholderForeground: #969696; --vscode-list-hoverBackground: #2a2d2e;
  --vscode-button-background: #0078d4; --vscode-button-foreground: #fff; --vscode-button-hoverBackground: rgb(2,110,193);
  --vscode-button-secondaryBackground: #313131; --vscode-button-secondaryForeground: #cccccc; --vscode-button-secondaryHoverBackground: #454545;
  --vscode-focusBorder: #007fd4; --vscode-errorForeground: #f48771;
  --vscode-scrollbarSlider-background: #79797966; --vscode-scrollbarSlider-hoverBackground: #646464b3;
}`;
let server, browser;
const screenshotDir = process.env.LIMCODE_SETTINGS_SCREENSHOTS;
before(async () => {
  server = await createBrowserFixtureServer({ dependencies: ['vue', 'pinia', '@tabler/icons-vue'], plugins: [{
    name: 'settings-layout-fixture', enforce: 'pre',
    resolveId(id) { if (id === 'virtual:settings-layout') return '\0' + id; },
    load(id) { if (id === '\0virtual:settings-layout') return entry; },
    configureServer(vite) {
      vite.middlewares.use('/settings-layout-fixture', async (_request, response) => {
        response.setHeader('Content-Type', 'text/html');
        response.end(await vite.transformIndexHtml('/settings-layout-fixture', `<meta charset="utf-8"><link rel="icon" href="data:,"><style>${theme}</style><div id="app"></div><script type="module">import 'virtual:settings-layout';</script>`));
      });
    }
  }] });
  await server.listen();
  browser = await chromium.launch({ headless: true, ...(process.env.LIMCODE_TEST_BROWSER_PATH ? { executablePath: process.env.LIMCODE_TEST_BROWSER_PATH } : {}) });
  if (screenshotDir) await mkdir(screenshotDir, { recursive: true });
});
after(async () => { try { await browser?.close(); } finally { await server?.close(); } });

async function pageFor(t) {
  const page = await browser.newPage({ viewport: { width: 1100, height: 900 }, locale: 'zh-CN' });
  page.setDefaultTimeout(5000);
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  t.after(async () => { await page.close(); assert.deepEqual(errors, []); });
  await page.addInitScript(() => {
    window.fixtureMessages = [];
    window.acquireVsCodeApi = () => ({ postMessage(message) { window.fixtureMessages.push(structuredClone(message)); }, getState() {}, setState() {} });
  });
  await page.goto(`http://127.0.0.1:${server.httpServer.address().port}/settings-layout-fixture`, { waitUntil: 'domcontentloaded', timeout: 30000 });
  await page.locator('.llm-generation-settings').waitFor({ timeout: 30000 });
  return page;
}
async function shot(page, name) {
  if (screenshotDir) await page.screenshot({ path: path.join(screenshotDir, name + '.png'), animations: 'disabled' });
}

test('完成提示音可试听、导入、调音量、保存和恢复内置音效', async t => {
  const p = await pageFor(t);
  await p.getByRole('button', { name: '其他', exact: true }).click();
  const toggle = p.getByRole('checkbox', { name: '任务完成提示音', exact: true });
  assert.equal(await toggle.isChecked(), false);
  await p.evaluate(() => {
    const play = HTMLMediaElement.prototype.play;
    HTMLMediaElement.prototype.play = function() { window.previewPlayer = this; return play.call(this); };
  });
  await p.getByRole('button', { name: '试听', exact: true }).click();
  await p.waitForFunction(() => window.previewPlayer?.readyState >= 2);
  assert.equal(await p.getByRole('alert').count(), 0, '内置 WAV 在真实浏览器中可以解码播放');
  await toggle.check();
  await p.getByRole('spinbutton', { name: '提示音音量', exact: true }).fill('70');
  const bytes = await p.evaluate(async () => Array.from(new Uint8Array(await (await fetch(window.fixture.builtInSound)).arrayBuffer())));
  await p.getByLabel('选择提示音文件', { exact: true }).setInputFiles({ name: '任务完成.wav', mimeType: 'audio/wav', buffer: Buffer.from(bytes) });
  await p.getByText('当前音效：任务完成.wav。', { exact: false }).waitFor();
  await p.getByRole('button', { name: '保存其他设置', exact: true }).click();
  await p.waitForFunction(() => window.fixtureMessages.some(m => m.type === 'settings.global.update' && m.payload.section === 'taskCompletionSound'));
  const saved = await p.evaluate(() => window.fixtureMessages.find(m => m.type === 'settings.global.update' && m.payload.section === 'taskCompletionSound').payload);
  assert.equal(saved.settings.enabled, true);
  assert.equal(saved.settings.volume, 70);
  assert.equal(saved.settings.audioName, '任务完成.wav');
  assert.match(saved.settings.audioDataUrl, /^data:audio\/wav;base64,/);
  assert.equal(saved.expectedRevision, 'fixture:taskCompletionSound');
  await shot(p, 'task-completion-sound');
  await p.getByRole('button', { name: '恢复内置音效', exact: true }).click();
  assert.equal(await p.evaluate(() => window.fixture.settings.taskCompletionSound.audioDataUrl), '');
  assert.equal(await p.getByRole('spinbutton', { name: '提示音音量', exact: true }).inputValue(), '70');
  await p.getByLabel('选择提示音文件', { exact: true }).setInputFiles({ name: 'too-large.wav', mimeType: 'audio/wav', buffer: Buffer.alloc(2 * 1024 * 1024 + 1) });
  assert.match(await p.getByRole('alert').textContent(), /2 MB/);
});

test('真实桥接只在对应主对话收到新完成通知时播放，播放器与音频复用', async t => {
  const p = await pageFor(t);
  const result = await p.evaluate(async () => {
    window.soundPlayers = [];
    window.Audio = class {
      constructor() { this.plays = 0; this.pauses = 0; this.sources = 0; window.soundPlayers.push(this); }
      set src(value) { this.source = value; this.sources++; }
      pause() { this.pauses++; }
      play() { this.plays++; return Promise.resolve(); }
    };
    const send = (type, payload) => window.dispatchEvent(new MessageEvent('message', { data: { id: crypto.randomUUID(), type, channel: 'control', payload } }));
    const hello = kind => send('bridge.hello', { meta: { kind, conversationId: 'conversation' } });
    const done = (turnId, conversationId = 'conversation') => send('task.completed', { turnId, conversationId });
    const settings = window.fixture.settings;
    window.fixture.mode.value = 'soundChat';
    await new Promise(resolve => requestAnimationFrame(resolve));
    hello('mainPanel');
    done('disabled');
    const defaultOff = window.soundPlayers.length === 0;
    settings.taskCompletionSound.enabled = true;
    done('other', 'other-conversation');
    const scoped = window.soundPlayers.length === 0;
    done('one'); done('two');
    const reused = window.soundPlayers.length === 1 && window.soundPlayers[0].plays === 2 && window.soundPlayers[0].sources === 1;
    settings.taskCompletionSound.audioDataUrl = 'data:audio/wav;base64,AAAA';
    settings.taskCompletionSound.volume = 35;
    done('three');
    const imported = window.soundPlayers[0].sources === 2 && window.soundPlayers[0].volume === 0.35;
    window.fixture.mode.value = 'input';
    await new Promise(resolve => requestAnimationFrame(resolve));
    window.fixture.mode.value = 'soundChat';
    await new Promise(resolve => requestAnimationFrame(resolve));
    const reopenSilent = window.soundPlayers[0].plays === 3;
    hello('planDetail'); done('plan');
    const planSilent = window.soundPlayers[0].plays === 3;
    hello('mainPanel');
    settings.taskCompletionSound.enabled = false;
    await new Promise(resolve => requestAnimationFrame(resolve));
    done('disabled-again');
    return { defaultOff, scoped, reused, imported, reopenSilent, planSilent, disabled: window.soundPlayers[0].plays === 3, stops: window.soundPlayers[0].pauses };
  });
  assert.deepEqual({ ...result, stops: undefined }, { defaultOff: true, scoped: true, reused: true, imported: true, reopenSilent: true, planSilent: true, disabled: true, stops: undefined });
  assert.ok(result.stops >= 5, '关闭开关或销毁视图停止播放');
});

test('Agent 模型可下拉选择并获取，默认显示选中渠道的默认配置', async t => {
  const p = await pageFor(t);
  await p.setViewportSize({ width: 400, height: 900 });
  await p.evaluate(() => {
    const { settings, mode } = window.fixture;
    settings.llmProviderConfigs.configs.push({ ...settings.llmProviderConfigs.configs[0], id: 'agent-target', name: 'Agent 渠道',
      provider: 'gemini', baseUrl: 'https://generativelanguage.googleapis.com/v1beta', model: 'gemini-3.8-flash',
      models: [{ id: 'gemini-3.8-flash', name: 'Flash' }, { id: 'gemini-3.1-pro-preview', name: 'Pro' }] });
    mode.value = 'model';
  });
  const editor = p.locator('.model-profile-editor');
  await editor.waitFor();
  await p.evaluate(() => {
    const read = window.fixtureMessages.findLast(message => message.type === 'modelProfile.scope.read');
    window.fixture.models.applyScopeSnapshot({ scopeKind: 'agent', scopeId: 'worker', authorityId: 'fixture', sessionId: 'worker',
      revision: '1', sequence: 1, outcome: 'observed', profileState: 'absent' }, read.id);
  });
  const source = editor.locator('.model-profile-grid .settings-dropdown-button').nth(0);
  const model = editor.locator('.model-profile-grid .settings-dropdown-button').nth(1);
  await source.click(); await p.getByRole('option', { name: /Agent 渠道/ }).click();
  assert.match(await model.innerText(), /渠道默认配置.*gemini-3\.8-flash/);
  assert.equal(await p.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth), true);
  await shot(p, 'agent-model-default-400');
  await editor.getByRole('button', { name: '获取模型', exact: true }).click();
  const dialog = p.getByRole('dialog', { name: '选择要添加的 LLM' });
  await dialog.waitFor();
  await p.evaluate(() => {
    const request = window.fixtureMessages.findLast(message => message.type === 'llm.providerModels.get');
    const config = request.payload.config;
    window.fixture.settings.applyLlmProviderModelsSnapshot({ configId: config.id, provider: config.provider, baseUrl: config.baseUrl,
      models: [{ id: 'gemini-new-option', name: '获取的新模型' }] }, request.id);
  });
  await dialog.locator('.model-fetch-loading').waitFor({ state: 'hidden' });
  await shot(p, 'agent-model-fetched-400');
  await dialog.getByRole('button', { name: /获取的新模型/ }).click();
  await dialog.getByRole('button', { name: '添加（1）', exact: true }).click();
  await dialog.waitFor({ state: 'hidden' });
  await model.click(); await p.getByRole('option', { name: /获取的新模型/ }).click();
  await editor.getByRole('button', { name: '保存 LLM 配置', exact: true }).click();
  const saved = await p.evaluate(() => window.fixtureMessages.findLast(message => message.type === 'modelProfile.scope.set'));
  assert.equal(saved.payload.providerConfigId, 'agent-target');
  assert.equal(saved.payload.model, 'gemini-new-option');
  assert.equal(saved.payload.scopeId, 'worker');
  const defaults = await p.evaluate(() => ({ active: window.fixture.settings.llm.activeProviderConfigId,
    model: window.fixture.settings.llmProviderConfigs.configs.find(item => item.id === 'agent-target').model }));
  assert.deepEqual(defaults, { active: 'provider', model: 'gemini-3.8-flash' });
});

test('图片发送开关独立并默认开启，关闭保留数字与选择，模型复制及保存保留确切值', async t => {
  const p = await pageFor(t);
  const dimension = p.getByRole('spinbutton', { name: '历史图片长边（像素）' });
  const budget = p.getByRole('spinbutton', { name: '图片发送上限（MB）' });
  assert.equal(await dimension.inputValue(), '1024');
  assert.equal(await budget.inputValue(), '16');
  const resize = p.getByRole('checkbox', { name: '缩小历史图片', exact: true });
  const limit = p.getByRole('checkbox', { name: '限制图片发送体积', exact: true });
  const omit = p.getByRole('checkbox', { name: '超限时省略最旧历史图片', exact: true });
  for (const toggle of [resize, limit, omit]) assert.equal(await toggle.isChecked(), true);
  await dimension.fill('2048'); await dimension.press('Tab');
  await budget.fill('8'); await budget.press('Tab');
  await resize.click();
  assert.equal(await dimension.isDisabled(), true);
  assert.equal(await limit.isChecked(), true);
  assert.equal(await omit.isChecked(), true);
  await limit.click();
  assert.equal(await budget.isDisabled(), true);
  assert.equal(await omit.isChecked(), true);
  await omit.click();
  const expected = { resizeEnabled: false, limitEnabled: false, omitOldestEnabled: false, maxDimension: 2048, maxMB: 8 };
  assert.deepEqual(await p.evaluate(() => window.fixture.settings.activeLlmProviderConfig.historyImages),
    expected);
  await resize.click(); await limit.click();
  assert.equal(await dimension.inputValue(), '2048');
  assert.equal(await budget.inputValue(), '8');
  assert.equal(await omit.isChecked(), false);
  await resize.click(); await limit.click();
  await p.evaluate(() => {
    window.fixture.settings.createModelConfigForActiveConfig('gpt-6-astra');
    window.fixture.settings.saveLlmProviderConfigs();
  });
  await p.waitForFunction(() => window.fixtureMessages.some(message => message.type === 'settings.global.update'));
  const saved = await p.evaluate(() => window.fixtureMessages.find(message => message.type === 'settings.global.update').payload.settings.configs[0]);
  assert.deepEqual(saved.historyImages, expected);
  assert.deepEqual(saved.modelConfigs[0].historyImages, expected);
});

test('settings fields align at wide and narrow widths; full model identity is available on hover and focus', async t => {
  const p = await pageFor(t);
  assert.doesNotMatch(await p.locator('.llm-generation-settings').innerText(), /最大输出 Token|Temperature|Top P/);
  for (const width of [360, 420, 750, 1100]) {
    await p.setViewportSize({ width, height: 900 });
    const geometry = await p.evaluate(() => {
      const capacity = document.querySelector('.context-window-field input').getBoundingClientRect();
      const controls = [...document.querySelectorAll('.known-parameter-control')].map(e => e.getBoundingClientRect().toJSON());
      const label = document.querySelector('.model-manager-header label'), actions = document.querySelector('.model-manager-actions');
      const range = document.createRange(); range.selectNodeContents(label);
      const contextLabel = getComputedStyle(document.querySelector('.context-window-field > span'));
      const parameterLabel = getComputedStyle(document.querySelector('.known-parameter-info .llm-setting-hint'));
      return { capacity: capacity.toJSON(), controls, lines: range.getClientRects().length,
        labelBottom: label.getBoundingClientRect().bottom, actionsTop: actions.getBoundingClientRect().top,
        labelsMatch: ['fontSize', 'fontWeight', 'color'].every(key => contextLabel[key] === parameterLabel[key]) };
    });
    assert.equal(geometry.lines, 1, `${width}px list title must stay on one line`);
    if (width <= 560) assert.ok(geometry.labelBottom <= geometry.actionsTop, 'narrow list actions belong below the title');
    assert.ok(geometry.labelsMatch, 'generation labels share the normal field hierarchy');
    assert.ok(geometry.controls.every(r => Math.abs(r.width - geometry.capacity.width) <= 1), 'capacity and parameter controls use equal-width columns');
    if (width > 560) assert.ok(Math.abs(geometry.controls[0].top - geometry.capacity.top) <= 1, 'first two controls align horizontally');
    else assert.ok(geometry.controls.every(r => Math.abs(r.left - geometry.capacity.left) <= 1), 'narrow controls share one left edge');
    await p.locator('.model-manager').scrollIntoViewIfNeeded(); await shot(p, `models-${width}`);
    await p.locator('.llm-generation-settings').scrollIntoViewIfNeeded(); await shot(p, `parameters-${width}`);
  }
  if (screenshotDir) {
    const light = await p.addStyleTag({ content: `:root {
      --vscode-editor-background: #fff; --vscode-foreground: #333; --vscode-descriptionForeground: #616161;
      --vscode-sideBar-background: #f3f3f3; --vscode-panel-border: #ddd; --vscode-input-background: #fff;
      --vscode-input-foreground: #333; --vscode-input-border: #cecece; --vscode-input-placeholderForeground: #767676;
      --vscode-list-hoverBackground: #e8e8e8; --vscode-editorWidget-background: #f3f3f3;
    }` });
    await p.setViewportSize({ width: 750, height: 900 });
    await p.locator('.llm-generation-settings').scrollIntoViewIfNeeded(); await shot(p, 'parameters-light-750');
    await light.evaluate(e => e.remove());
  }
  await p.setViewportSize({ width: 360, height: 900 });
  const identity = p.locator('.model-identity-tooltip').last();
  await identity.scrollIntoViewIfNeeded(); await identity.hover();
  await p.getByRole('tooltip').waitFor();
  assert.ok((await p.getByRole('tooltip').innerText()).includes(longId));
  await identity.press('Escape'); await p.getByRole('tooltip').waitFor({ state: 'hidden' });
  await identity.press('Tab'); await p.keyboard.press('Shift+Tab');
  await p.getByRole('tooltip').waitFor();
  await p.waitForFunction(() => { const r = document.querySelector('[role="tooltip"]')?.getBoundingClientRect(); return r && r.left >= 0 && r.right <= innerWidth; });
  await shot(p, 'model-identity-focus');
  await identity.press('Escape'); await identity.press('Enter');
  assert.equal(await p.locator('.model-item.enabled .model-id').textContent(), `ID: ${longId}`);
  assert.equal(await p.evaluate(() => window.fixture.settings.activeLlmProviderConfig.model), 'gpt-6-astra', 'keyboard editing must not activate the model');
});

test('blocked-result notice uses the card width and keeps the existing confirmation gate', async t => {
  const p = await pageFor(t);
  await p.getByRole('button', { name: '工具', exact: true }).click();
  await p.getByRole('button', { name: /edit.*配置/ }).click();
  for (const width of [360, 1100]) {
    await p.setViewportSize({ width, height: 900 });
    const card = p.locator('.tool-result-blocked-card'); await card.scrollIntoViewIfNeeded();
    const geometry = await card.evaluate(e => ({ card: e.clientWidth, copy: e.querySelector('.permission-copy').clientWidth }));
    assert.ok(geometry.copy > geometry.card / 2, 'notice must not occupy the checkbox-only 16px column');
    await shot(p, `tool-blocked-${width}`);
  }
  const restore = p.getByRole('button', { name: '恢复自动回传…', exact: true });
  await restore.hover();
  assert.notEqual(await restore.evaluate(e => getComputedStyle(e).backgroundColor), 'rgb(2, 110, 193)');
  await restore.click(); await p.setViewportSize({ width: 360, height: 900 });
  await p.getByRole('dialog').waitFor(); await shot(p, 'tool-restore-confirm');
  await p.getByRole('button', { name: '取消', exact: true }).click();
  assert.equal(await p.evaluate(() => window.fixture.client.toolPolicies[0].toolConfigs.edit.autoSubmitResult), false);
});

test('InputPanel delays error display without relaxing required, custom, optional or IME validation', async t => {
  const p = await pageFor(t);
  await p.setViewportSize({ width: 360, height: 900 });
  await p.getByRole('button', { name: '新建 LLM', exact: true }).click();
  const input = p.getByRole('textbox', { name: 'LLM ID', exact: true });
  assert.equal(await p.locator('.input-panel-error').count(), 0);
  assert.equal(await p.getByRole('button', { name: '添加 LLM', exact: true }).isDisabled(), true);
  await shot(p, 'new-model-initial');
  await input.press('Enter');
  assert.equal(await p.locator('.input-panel-error').textContent(), 'LLM ID不能为空');
  assert.equal(await input.getAttribute('aria-invalid'), 'true');
  await input.fill('valid-model'); assert.equal(await p.locator('.input-panel-error').count(), 0);
  await input.fill(' '); assert.equal(await p.getByRole('button', { name: '添加 LLM', exact: true }).isDisabled(), true);
  await input.press('Escape'); await p.getByRole('button', { name: '新建 LLM', exact: true }).click();
  assert.equal(await p.locator('.input-panel-error').count(), 0, 'reopening resets interaction state');
  await input.press('Tab'); assert.equal(await p.locator('.input-panel-error').textContent(), 'LLM ID不能为空');
  await shot(p, 'new-model-invalid'); await p.getByRole('button', { name: '取消', exact: true }).click();
  await p.evaluate(() => window.fixture.mode.value = 'input');
  const name = p.getByRole('textbox', { name: '名称', exact: true });
  assert.equal(await p.getByRole('button', { name: '保存', exact: true }).isDisabled(), true, 'initial custom error still blocks saving');
  await name.press('Enter'); assert.equal(await p.locator('.input-panel-error').textContent(), '名称已存在');
  await name.fill('good'); await name.dispatchEvent('keydown', { key: 'Enter', isComposing: true, bubbles: true });
  assert.deepEqual(await p.evaluate(() => window.fixture.confirmed), []);
  await name.press('Enter'); assert.deepEqual(await p.evaluate(() => window.fixture.confirmed), ['good']);
  await p.evaluate(() => { window.fixture.inputProps.required = false; window.fixture.inputProps.initialValue = ''; });
  await name.press('Enter'); assert.deepEqual(await p.evaluate(() => window.fixture.confirmed), ['good', '']);
});
