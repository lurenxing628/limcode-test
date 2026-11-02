import assert from 'node:assert/strict';
import { before, after, test } from 'node:test';
import { mkdir } from 'node:fs/promises';
import { chromium } from 'playwright';
import { createBrowserFixtureServer } from './reliable-kernel/browser-fixture-server.mjs';

const entry = `
import { createApp, h, ref } from 'vue';
import { createPinia } from 'pinia';
import Composer from '/src/components/input/Composer.vue';
import MessageList from '/src/components/conversation/ReliableMessageList.vue';
import { useClientStateStore } from '/src/stores/useClientStateStore';
import { useGlobalSettingsStore } from '/src/stores/useGlobalSettingsStore';
import { useSessionStore } from '/src/stores/useSessionStore';
import { useWorkEnvironmentStore } from '/src/stores/useWorkEnvironmentStore';
import { useReliableKernelClientFeedStore } from '/src/stores/useReliableKernelClientFeedStore';
import { GLOBAL_SETTINGS_SECTIONS } from '@shared/protocol';
import '/src/theme/tokens.css'; import '/src/theme/base.css'; import '/src/theme/motion/dropdown.css';
const pinia = createPinia(), mode = ref('menus');
const app = createApp({ setup: () => () => mode.value === 'menus'
  ? h('div', { class: 'composer-fixture' }, [h(Composer)]) : h(MessageList) }).use(pinia);
const client = useClientStateStore(pinia), settings = useGlobalSettingsStore(pinia), feed = useReliableKernelClientFeedStore(pinia);
const session = useSessionStore(pinia), environments = useWorkEnvironmentStore(pinia);
client.configurationReady = true; client.currentConversationId = 'self';
session.applyHello({ kind: 'mainPanel', conversationId: 'self' });
client.agents = [{ id: 'main', name: '主助手', type: 'main', createdAt: 1, updatedAt: 1 }];
client.workflows = ['Plan', 'Research', 'Review'].map(id => ({ id, name: id, source: 'builtin', description: id + ' 工作流的完整说明', createdAt: 1, updatedAt: 1 }));
const provider = { id: 'provider', name: '默认渠道', provider: 'openai-compatible', model: 'model', stream: true,
  baseUrl: 'https://example.invalid/v1', apiKey: '', generationConfig: {}, requestBody: {}, headers: {}, modelConfigs: [],
  models: ['model', 'long-model-name-with-a-readable-description'].map(id => ({ id, name: id })) };
for (const section of GLOBAL_SETTINGS_SECTIONS) settings.applySnapshot({ section, settings:
  section === 'llmProviderConfigs' ? { configs: [provider] } : section === 'llm' ? { activeProviderConfigId: 'provider' }
  : JSON.parse(JSON.stringify(settings[section])), revision: 'fixture', filePath: 'memory' });
const allowed = Array.from({ length: 12 }, (_, i) => ({ id: 'env-' + i, kind: 'local', name: '工作目录 ' + i,
  rootPath: '/home/user/projects/readable-work-directory-' + i, available: true, index: i }));
environments.allowedEnvironmentsForConversation = () => allowed;
environments.environmentSelectionForConversation = () => ({ allowed, error: '工作环境未获当前策略允许：旧工作目录，请重新选择。' });
environments.workEnvironmentEnabledForConversation = () => true;
feed.projections = { activeConversationWindow: { conversationId: 'self' } };
feed.sessionId = 'feed'; feed.synchronizeCollaborationHistoryScope('self', true);
feed.collaborationHistoryNextBeforeCursor = { kind: 'message' };
feed.collaborationHistoryHasMoreBefore = true;
feed.collaborationHistoryLoadedPages = 1;
const posted = [];
window.fixture = { client, settings, feed, mode, posted, hold: false, pages: 0, errors: false,
  resetHistory() { feed.synchronizeCollaborationHistoryScope('self', true); feed.collaborationHistoryNextBeforeCursor = { kind: 'message' }; feed.collaborationHistoryHasMoreBefore = true; feed.collaborationHistoryLoadedPages = 1; this.pages = 0; },
  messagePage(records, sequence, scannedRows = 4096) {
    const rows = records.CollaborationMessage ?? [];
    const newest = rows.reduce((value, row) => !value || BigInt(row.message_seq) > BigInt(value.message_seq) ? row : value, null);
    const oldest = rows.find(row => row.message_seq === String(sequence));
    const nextBeforeCursor = { kind: 'message', beforeMessageSeq: String(sequence), beforeId: oldest?.id ?? 'cursor-' + sequence };
    return { records, hasMoreBefore: true, hasMoreAfter: true, nextBeforeCursor,
      nextAfterCursor: { kind: 'message', afterMessageSeq: newest?.message_seq ?? String(sequence), afterId: newest?.id ?? 'cursor-' + sequence },
      hasMore: true, nextCursor: nextBeforeCursor, scanProgress: rows.length === 0, scannedRows, responseBytes: 0 };
  },
  handle(message) {
    posted.push(message);
    if (message.type !== 'reliable-kernel.collaboration-history-request') return;
    const n = ++this.pages;
    if (this.hold) return;
    setTimeout(() => {
      if (this.errors) { feed.observeCollaborationHistoryError({ ...message, message: '测试读取失败' }); return; }
      // Two empty message scans, then the real message -> answer transition and answer end.
      const page = this.messagePage({}, 100 - n);
      if (n === 3) { page.nextBeforeCursor = { kind: 'answer' }; page.nextCursor = page.nextBeforeCursor; }
      if (n === 4) Object.assign(page, { hasMoreBefore: false, hasMore: false, scanProgress: false,
        nextBeforeCursor: { kind: 'answer' }, nextAfterCursor: { kind: 'message' }, nextCursor: undefined });
      feed.observeCollaborationHistoryResult({ ...message, page });
    }, 20);
  }
};
app.mount('#app');
`;
const theme = `:root { --vscode-font-family: sans-serif; --vscode-editor-background: #1f1f1f; --vscode-foreground: #ccc;
--vscode-descriptionForeground: #aaa; --vscode-panel-border: #444; --vscode-input-background: #292929;
--vscode-input-foreground: #ddd; --vscode-list-hoverBackground: #333; --vscode-editorWarning-foreground: #d9b45b; }
body { margin: 8px; background: #1f1f1f; color: #ccc; } .composer-fixture { position: fixed; left: 8px; right: 8px; bottom: 8px; }`;
let server, browser;
const screenshotDir = process.env.LIMCODE_COMPOSER_SCREENSHOTS;
before(async () => {
  server = await createBrowserFixtureServer({ dependencies: ['vue', 'pinia', '@tabler/icons-vue', 'markdown-it', 'markdown-it-texmath', 'katex'], plugins: [{
    name: 'composer-fixture', enforce: 'pre',
    resolveId(id) { if (id === 'virtual:composer-fixture') return '\0' + id; },
    load(id) { if (id === '\0virtual:composer-fixture') return entry; },
    configureServer(vite) { vite.middlewares.use('/composer-fixture', async (_request, response) => {
      response.setHeader('Content-Type', 'text/html');
      response.end(await vite.transformIndexHtml('/composer-fixture', `<meta charset="utf-8"><link rel="icon" href="data:,"><style>${theme}</style><div id="app"></div><script type="module">import('virtual:composer-fixture').catch(error => { window.fixtureError = error.stack; console.error(error.stack); });</script>`));
    }); }
  }] });
  await server.listen();
  browser = await chromium.launch({ headless: true, ...(process.env.LIMCODE_TEST_BROWSER_PATH ? { executablePath: process.env.LIMCODE_TEST_BROWSER_PATH } : {}) });
  if (screenshotDir) await mkdir(screenshotDir, { recursive: true });
});
after(async () => { await browser?.close(); await server?.close(); });
async function pageFor(t, width = 360) {
  const page = await browser.newPage({ viewport: { width, height: 800 } });
  page.setDefaultTimeout(10000);
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  t.after(async () => { await page.close(); assert.deepEqual(errors, []); });
  await page.addInitScript(() => { window.acquireVsCodeApi = () => ({ getState() {}, setState() {},
    postMessage(message) { window.fixture?.handle(structuredClone(message)); } }); });
  await page.goto(`http://127.0.0.1:${server.httpServer.address().port}/composer-fixture`, { waitUntil: 'domcontentloaded', timeout: 30000 });
  await page.waitForFunction(() => !!window.fixture || !!window.fixtureError, null, { timeout: 30000 });
  assert.equal(await page.evaluate(() => window.fixtureError), undefined);
  return page;
}
async function bounds(page, selector) {
  await page.locator(selector).waitFor();
  await page.waitForFunction(selector => {
    const el = document.querySelector(selector); if (!el || el.classList.contains('lc-dropdown-enter-active')) return false;
    const r = el.getBoundingClientRect(); return r.left >= 7 && r.right <= innerWidth - 7 && r.top >= 7 && r.bottom <= innerHeight - 7;
  }, selector);
  return page.locator(selector).boundingBox();
}

test('真实输入栏全部菜单独立于按钮宽度，窄窗和大字体不越界', async t => {
  const p = await pageFor(t);
  for (const width of [320, 480, 1000]) {
    await p.setViewportSize({ width, height: 800 });
    for (const selector of ['.composer-agent-dropdown', '.composer-workflow-dropdown', '.composer-channel-dropdown', '.composer-work-environment-dropdown']) {
      const button = p.locator(selector + ' > button');
      await button.click();
      const box = await bounds(p, selector + ' .settings-dropdown-panel');
      assert.ok(box.width >= Math.min(280, width - 16) - 1, `${selector} at ${width}: ${box.width}`);
      assert.ok(box.width > (await button.boundingBox()).width);
      assert.ok((await p.locator(selector + ' input').boundingBox()).width > 150);
      await p.locator(selector + ' input').press('Escape');
      await p.locator(selector + ' .settings-dropdown-panel').waitFor({ state: 'hidden' });
    }
  }
  await p.setViewportSize({ width: 360, height: 800 });
  await p.evaluate(() => document.documentElement.style.setProperty('--font-size-sm', '20px'));
  await p.locator('.composer-workflow-dropdown > button').click();
  await bounds(p, '.composer-workflow-dropdown .settings-dropdown-panel');
  if (screenshotDir) await p.screenshot({ path: `${screenshotDir}/workflow-narrow.png` });
});

test('目录说明不随搜索聚焦弹出，最末选项可点击', async t => {
  const p = await pageFor(t);
  await p.getByRole('button', { name: '工作目录说明', exact: true }).focus();
  await p.getByRole('tooltip').waitFor();
  await p.locator('.composer-work-environment-dropdown > button').click();
  await p.getByRole('tooltip').waitFor({ state: 'hidden' });
  assert.ok(await p.locator('.composer-directory-warning').isVisible());
  const bottomOption = p.locator('.composer-work-environment-dropdown').getByRole('option', { name: /^工作目录 11\b/ });
  await bottomOption.scrollIntoViewIfNeeded();
  await bottomOption.focus();
  assert.equal(await p.getByRole('tooltip').count(), 0);
  if (screenshotDir) await p.screenshot({ path: `${screenshotDir}/directory-last-option.png` });
  const search = p.locator('.composer-work-environment-dropdown input');
  await search.fill('工作目录 11');
  const last = p.locator('.composer-work-environment-dropdown').getByRole('option');
  await last.click();
  assert.equal(await p.getByRole('tooltip').count(), 0);
  assert.ok(await p.evaluate(() => window.fixture.posted.some(m => m.type === 'workEnvironment.select' || m.payload?.workEnvironmentId === 'env-11')));
});

test('模型菜单宽窗并排、窄窗返回渠道，不再固定170px', async t => {
  const p = await pageFor(t);
  await p.locator('.composer-channel-dropdown > button').click();
  await p.getByRole('button', { name: '切换该渠道的 LLM', exact: true }).click();
  await p.getByRole('button', { name: '‹ 返回渠道' }).waitFor();
  await bounds(p, '.composer-channel-dropdown .settings-dropdown-panel');
  if (screenshotDir) await p.screenshot({ path: `${screenshotDir}/models-narrow.png` });
  await p.getByRole('button', { name: '‹ 返回渠道' }).click();
  await p.setViewportSize({ width: 1200, height: 800 });
  await p.getByRole('button', { name: '切换该渠道的 LLM', exact: true }).click();
  assert.ok((await bounds(p, '.channel-model-panel')).width >= 280);
});

test('协作查找跨空页显示进度、查完结束、停止不继续请求、失败保留游标', async t => {
  const p = await pageFor(t);
  await p.evaluate(() => window.fixture.mode.value = 'history');
  await p.getByRole('button', { name: '查找更早协作记录', exact: true }).click();
  await p.getByText('没有更早的协作记录', { exact: false }).waitFor();
  assert.equal(await p.evaluate(() => window.fixture.pages), 4);
  assert.deepEqual(await p.evaluate(() => window.fixture.posted
    .filter(message => message.type === 'reliable-kernel.collaboration-history-request')
    .map(message => [message.direction, message.cursor.kind])),
  [['before', 'message'], ['before', 'message'], ['before', 'message'], ['before', 'answer']]);
  assert.match(await p.locator('.reliable-collaboration-progress').innerText(), /16,384/);
  await p.evaluate(() => { window.fixture.resetHistory(); window.fixture.hold = true; });
  await p.getByRole('button', { name: '查找更早协作记录', exact: true }).click();
  await p.getByRole('button', { name: '停止查找', exact: true }).click();
  await p.evaluate(() => {
    const f = window.fixture, message = f.posted.filter(m => m.type === 'reliable-kernel.collaboration-history-request').at(-1);
    f.feed.observeCollaborationHistoryResult({ ...message, page: f.messagePage({}, 50) });
  });
  await p.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
  assert.equal(await p.evaluate(() => window.fixture.pages), 1);
  await p.evaluate(() => { window.fixture.hold = false; window.fixture.errors = true; });
  await p.getByRole('button', { name: '查找更早协作记录', exact: true }).click();
  await p.getByText('测试读取失败', { exact: true }).waitFor();
  assert.equal(await p.evaluate(() => window.fixture.feed.collaborationHistoryNextBeforeCursor.beforeMessageSeq), '50');
  assert.equal(await p.evaluate(() => window.fixture.posted
    .filter(message => message.type === 'reliable-kernel.collaboration-history-request').at(-1).cursor.beforeMessageSeq), '50');
});

test('协作查找跨过已展示卡片和空页，找到新卡片即停', async t => {
  const p = await pageFor(t);
  await p.evaluate(() => {
    const f = window.fixture;
    f.hold = true;
    f.card = (id, seq) => ({
      CollaborationMessage: [{ id, message_seq: String(seq), mode: 'message', text_preview: id === 'new' ? '历史新消息' : '已展示消息' }],
      CollaborationMessageSourceLink: [{ id: id + '-source', message_id: id, conversation_id: 'self', source_kind: 'tool' }],
      CollaborationMessageTargetLink: [{ id: id + '-target', message_id: id, conversation_id: 'peer', inbox_item_id: id + '-inbox' }],
      CollaborationPeerConversation: [{ id: 'peer', title: '协作方', status: 'active' }]
    });
    const known = f.card('known', 90);
    f.feed.observe({ type: 'reliable-kernel.snapshot', sessionId: 'feed', hostBootId: 'composer-fixture',
      messageSeq: '1', snapshotCommitSeq: '0', projections: { activeConversationWindow: {
        conversationId: 'self', collaborationMessages: known.CollaborationMessage,
        collaborationMessageSourceLinks: known.CollaborationMessageSourceLink,
        collaborationMessageTargetLinks: known.CollaborationMessageTargetLink,
        collaborationPeerConversations: known.CollaborationPeerConversation
      } } });
    f.reply = (records, sequence) => {
      const request = f.posted.filter(m => m.type === 'reliable-kernel.collaboration-history-request').at(-1);
      f.feed.observeCollaborationHistoryResult({ ...request, page: f.messagePage(records, sequence, 10) });
    };
    f.mode.value = 'history';
  });
  await p.getByRole('button', { name: '查找更早协作记录', exact: true }).click();
  await p.evaluate(() => window.fixture.reply(window.fixture.card('known', 90), 89));
  await p.waitForFunction(() => window.fixture.pages === 2);
  await p.evaluate(() => window.fixture.reply({}, 88));
  await p.waitForFunction(() => window.fixture.pages === 3);
  await p.evaluate(() => window.fixture.reply(window.fixture.card('new', 87), 87));
  await p.getByText('已找到更早的协作记录', { exact: false }).waitFor();
  await p.locator('[data-timeline-row-key="collaboration:new"]').waitFor();
  assert.equal(await p.getByRole('button', { name: '停止查找', exact: true }).count(), 0);
  assert.equal(await p.evaluate(() => window.fixture.pages), 3);
});

test('输入法用回车确认文字时不发送，确认后的回车照常发送', async t => {
  const p = await pageFor(t), input = p.locator('textarea.rich-editor-control');
  const sent = () => p.evaluate(() => window.fixture.posted.filter(m => m.type === 'turn.start' || m.type === 'turn.enqueue').map(m => m.payload?.text));
  await input.fill('你好 ');
  // macOS 上 Chromium 的顺序：先把回车作为 keyCode 229、isComposing 的 keydown 交给页面，再提交输入法文字。
  const cdp = await p.context().newCDPSession(p);
  await cdp.send('Input.imeSetComposition', { text: 'test', selectionStart: 4, selectionEnd: 4 });
  await cdp.send('Input.dispatchKeyEvent', { type: 'rawKeyDown', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 229 });
  await cdp.send('Input.insertText', { text: 'test' });
  assert.equal(await input.inputValue(), '你好 test');
  assert.deepEqual(await sent(), []);
  await input.press('Enter');
  await p.waitForFunction(() => window.fixture.posted.some(m => m.type === 'turn.start' || m.type === 'turn.enqueue'));
  assert.deepEqual(await sent(), ['你好 test']);
});

test('空输入框按↑↓翻看发过的消息，←→、输入或输入法转为编辑，翻看时回车直接发送', async t => {
  const p = await pageFor(t), input = p.locator('textarea.rich-editor-control'), hint = p.locator('.rich-editor-history-hint');
  await p.evaluate(() => {
    const { feed } = window.fixture;
    const rows = [['m1', 'user', '第一条'], ['m2', 'model', '回复'], ['m3', 'user', '第二条\n第二行'], ['m4', 'user', '第二条\n第二行'], ['m5', 'user', '最新一条']];
    feed.committedRecords = { ...feed.committedRecords, Message: Object.fromEntries(rows.map(([id, role], index) =>
      [id, { id, conversation_id: 'self', role, revision_id: 'r-' + id, message_seq: String(index + 1), deleted_at: null }])) };
    for (const [id, , text] of rows) feed.details['message-content:r-' + id] = { status: 'ready', text, totalBytes: text.length };
  });
  const press = async (...keys) => { for (const key of keys) await input.press(key); };
  await input.click();
  await press('ArrowUp');
  assert.equal(await input.inputValue(), '最新一条');
  assert.match(await hint.innerText(), /历史 1\/3/);
  await press('ArrowUp');
  if (screenshotDir) await p.screenshot({ path: `${screenshotDir}/history-browsing.png` });
  await press('ArrowUp', 'ArrowUp');
  assert.equal(await input.inputValue(), '第一条', '相邻重复只留一条，翻到最早一条停住');
  await press('ArrowDown');
  assert.equal(await input.inputValue(), '第二条\n第二行', '多行消息里 ↓ 仍是翻看');
  await press('ArrowDown', 'ArrowDown');
  assert.equal(await input.inputValue(), '', '翻过最新一条回到空输入框');
  assert.equal(await hint.count(), 0);
  await press('ArrowUp', 'ArrowUp', 'ArrowLeft', 'ArrowUp');
  assert.equal(await input.inputValue(), '第二条\n第二行', '← 之后 ↑ 只移动光标');
  assert.equal(await hint.count(), 0);

  await input.fill('');
  await press('ArrowUp');
  const cdp = await p.context().newCDPSession(p);
  await cdp.send('Input.imeSetComposition', { text: 'ce', selectionStart: 2, selectionEnd: 2 });
  assert.equal(await hint.count(), 0, '输入法开始输入即转为编辑');
  await cdp.send('Input.dispatchKeyEvent', { type: 'rawKeyDown', key: 'ArrowUp', code: 'ArrowUp', windowsVirtualKeyCode: 229 });
  await cdp.send('Input.insertText', { text: '测' });
  assert.equal(await input.inputValue(), '最新一条测');

  await input.fill('');
  await press('ArrowUp', 'ArrowUp', 'Enter');
  await p.waitForFunction(() => window.fixture.posted.some(m => m.type === 'turn.start' || m.type === 'turn.enqueue'));
  assert.deepEqual(await p.evaluate(() => window.fixture.posted.filter(m => m.type === 'turn.start' || m.type === 'turn.enqueue').map(m => m.payload?.text)), ['第二条\n第二行']);
});
