import assert from 'node:assert/strict';
import path from 'node:path';
import { createRequire } from 'node:module';
import { after, before, test } from 'node:test';
import { chromium } from 'playwright';

// 真实的局域网服务 + 真实的 dist/webview，只有 Facade 是假的。
const require = createRequire(import.meta.url);
const Module = require('node:module');
const originalLoad = Module._load;
const vscode = {
  EventEmitter: class { event = () => ({ dispose() {} }); fire() {} dispose() {} },
  Uri: { file: (fsPath) => ({ fsPath }), joinPath: (base, ...parts) => ({ fsPath: path.join(base.fsPath, ...parts) }) },
  ViewColumn: { One: 1 },
  StatusBarAlignment: { Right: 2 },
  workspace: { workspaceFolders: [], name: '工作区' },
  commands: { executeCommand: async () => undefined },
  window: {}
};
Module._load = function load(name, parent, isMain) {
  return name === 'vscode' ? vscode : originalLoad.call(this, name, parent, isMain);
};
const { LanMobileAccessServer } = require(path.resolve('dist/extension/vscode/lanMobileAccess.js'));
Module._load = originalLoad;

const PROJECT_A = 'file:///project-a';
const PROJECT_B = 'file:///project-b';
const CLOSED = 'file:///closed';
const entries = Array.from({ length: 70 }, (_, index) => {
  const [uri, name] = index % 7 === 3 ? [CLOSED, 'closed'] : index % 5 === 4 ? [PROJECT_B, 'project-b'] : [PROJECT_A, 'project-a'];
  return { id: `c${index}`, title: `对话${index}-${name}`, updatedAt: Date.now() - index * 3_600_000, isRunning: false, projectFolderUri: uri, projectName: name };
});
const created = [];
const opened = [];
const failures = { page: false, create: false };
const application = {
  attachWebview(webview, meta) { this.client = { webview, meta }; return 'client'; },
  setWebviewVisible() {},
  detachWebview() {},
  handleReliableKernelControl() { return true; },
  handleWebviewMessage(clientId, message) {
    if (message.type !== 'bridge.ready') return;
    this.client.webview.postMessage({ id: 'hello', clientId, type: 'bridge.hello', channel: 'control', payload: { clientId, attachedAt: 1, meta: this.client.meta } });
    this.client.webview.postMessage({ type: 'reliable-kernel.snapshot', sessionId: 'feed', hostBootId: 'host', messageSeq: '1', snapshotCommitSeq: '1',
      projections: { activeConversationWindow: { conversationId: this.client.meta.conversationId } } });
  },
  getConversationDisplayTitle: (id) => `标题 ${id}`,
  getProjectFolderCandidates: () => [{ uri: PROJECT_A, name: 'project-a', index: 0 }, { uri: PROJECT_B, name: 'project-b', index: 1 }],
  async getConversationHistoryPage({ scopeKind, projectFolderUri, cursor, limit }) {
    if (failures.page) throw new Error('读取历史失败');
    const folder = scopeKind === 'currentProject' ? PROJECT_A : projectFolderUri;
    const rows = entries.filter((entry) => scopeKind === 'all' || entry.projectFolderUri === folder);
    const offset = Number(cursor ?? 0);
    const hasNext = offset + limit < rows.length;
    return { scope: { kind: scopeKind }, originLinks: [], entries: rows.slice(offset, offset + limit),
      pageInfo: { limit, hasNext, total: rows.length, ...(hasNext ? { nextCursor: String(offset + limit) } : {}) } };
  },
  async createConversation(options) {
    created.push(options);
    if (failures.create) throw new Error('项目不属于当前工作区');
    return 'c1';
  }
};

let server, browser, base;
before(async () => {
  server = new LanMobileAccessServer({
    application: async () => application,
    webviewRoot: path.resolve('dist/webview'),
    workspaceName: () => '工作区',
    activeConversationId: () => 'c1',
    openConversations: () => ['c1'],
    openConversation: async (id) => { opened.push(id); }
  });
  base = `http://127.0.0.1:${await server.start(0, '127.0.0.1')}`;
  browser = await chromium.launch({ headless: true, ...(process.env.LIMCODE_TEST_BROWSER_PATH ? { executablePath: process.env.LIMCODE_TEST_BROWSER_PATH } : {}) });
});
after(async () => {
  await browser?.close();
  server?.stop();
});

async function pageFor(t, viewport = { width: 390, height: 844 }) {
  const context = await browser.newContext({ viewport, hasTouch: true, isMobile: true });
  t.after(() => context.close());
  const page = await context.newPage();
  page.setDefaultTimeout(10_000);
  const errors = [];
  page.on('pageerror', (error) => errors.push(error.message));
  t.after(() => assert.deepEqual(errors, []));
  await page.goto(`${base}/?cid=c1`);
  await page.locator('textarea').waitFor();
  return page;
}
const drawer = (page) => page.locator('#limcode-mobile-drawer');
const scopeSelect = (page) => drawer(page).locator('select');
const titles = (page) => drawer(page).locator('.item .title').allTextContents();
const drawerOpen = (page) => page.evaluate(() => document.querySelector('#limcode-mobile-drawer').open);
async function openList(page) {
  await page.locator('#limcode-mobile-bar [data-menu]').tap();
  await drawer(page).locator('.item').first().waitFor();
}
async function waitClosed(page) {
  await page.waitForFunction(() => !document.querySelector('#limcode-mobile-drawer').open);
}

test('手机布局：页面正好一屏，发送按钮在屏幕内，键盘弹出后输入框留在可视区', async (t) => {
  const page = await pageFor(t);
  const layout = () => page.evaluate(() => ({
    pageHeight: document.documentElement.scrollHeight,
    pageWidth: document.documentElement.scrollWidth,
    sendBottom: document.querySelector('.composer-send').getBoundingClientRect().bottom,
    textareaBottom: document.querySelector('textarea').getBoundingClientRect().bottom,
    textareaFont: getComputedStyle(document.querySelector('textarea')).fontSize
  }));
  const full = await layout();
  assert.equal(full.pageHeight, 844);
  assert.equal(full.pageWidth, 390);
  assert.ok(full.sendBottom <= 844, `发送按钮被裁掉：${full.sendBottom}`);
  assert.equal(full.textareaFont, '16px', '不足 16px 时 iOS 聚焦会放大整页');
  await page.setViewportSize({ width: 390, height: 500 });
  await page.waitForFunction(() => document.documentElement.style.getPropertyValue('--limcode-app-height') === '500px');
  const small = await layout();
  assert.equal(small.pageHeight, 500);
  assert.ok(small.sendBottom <= 500, `发送按钮被键盘挡住：${small.sendBottom}`);
});

test('对话列表：默认当前项目，可切范围并记住，能翻页，手机上全屏', async (t) => {
  const page = await pageFor(t);
  await openList(page);
  const box = await drawer(page).boundingBox();
  assert.deepEqual([box.width, box.height], [390, 844], '手机上全屏');
  assert.equal(await scopeSelect(page).inputValue(), 'currentProject');
  assert.deepEqual(await scopeSelect(page).locator('option').allTextContents(), ['当前项目', 'project-a', 'project-b', '未绑定项目', '全部历史']);
  assert.ok((await titles(page)).every((title) => title.includes('project-a')), '当前项目不混入其它项目');
  assert.equal(await drawer(page).locator('.item.current').count(), 1);
  assert.equal(await drawer(page).locator('.item.current .title').textContent(), '● 对话1-project-a', '当前对话高亮，桌面已打开的有标记');

  await scopeSelect(page).selectOption('all');
  await page.waitForFunction(() => document.querySelectorAll('#limcode-mobile-drawer .item').length === 50);
  const metas = await drawer(page).locator('.item .meta').allTextContents();
  assert.ok(metas.some((meta) => meta.includes('closed') && meta.includes('继续对话需打开它的项目')), '不在这个窗口的项目有提示');
  assert.ok(!metas.some((meta) => meta.includes('project-b') && meta.includes('继续对话')), '这个窗口的项目没有提示');
  await drawer(page).getByRole('button', { name: '加载更多' }).tap();
  await page.waitForFunction(() => document.querySelectorAll('#limcode-mobile-drawer .item').length === 70);
  assert.equal(await drawer(page).getByRole('button', { name: '加载更多' }).count(), 0);

  await page.reload();
  await openList(page);
  assert.equal(await scopeSelect(page).inputValue(), 'all', '刷新后记住范围');

  await page.evaluate(() => localStorage.setItem('limcode-mobile-scope', JSON.stringify({ kind: 'project', folderUri: 'file:///gone' })));
  await page.reload();
  await openList(page);
  assert.equal(await scopeSelect(page).inputValue(), 'currentProject', '记住的项目不在这个窗口时退回当前项目');
});

test('对话列表：关闭和返回键留在原对话，切换对话后返回不残留列表', async (t) => {
  const page = await pageFor(t);
  await openList(page);
  await drawer(page).locator('[data-close]').tap();
  await waitClosed(page);
  assert.equal(new URL(page.url()).search, '?cid=c1');

  await openList(page);
  await page.goBack();
  await waitClosed(page);
  assert.equal(new URL(page.url()).search, '?cid=c1', '返回键只关闭列表');

  await openList(page);
  await drawer(page).locator('.item', { hasText: '对话2-project-a' }).tap();
  await page.waitForURL(/cid=c2$/);
  assert.equal(opened.at(-1), 'c2');
  await page.locator('textarea').waitFor();
  await page.goBack();
  await page.waitForURL(/cid=c1$/);
  assert.equal(await drawerOpen(page), false);

  await openList(page);
  await drawer(page).locator('.item.current').tap();
  await waitClosed(page);
  assert.equal(new URL(page.url()).search, '?cid=c1', '点当前对话只关闭列表');
});

test('平板上是侧边抽屉，点遮罩关闭', async (t) => {
  const page = await pageFor(t, { width: 820, height: 1180 });
  await openList(page);
  assert.equal((await drawer(page).boundingBox()).width, 400);
  await page.touchscreen.tap(700, 600);
  await waitClosed(page);
});

test('新建带上所选项目；读取和新建失败时显示原因', async (t) => {
  const page = await pageFor(t);
  await openList(page);
  await scopeSelect(page).selectOption(`project:${PROJECT_B}`);
  await page.waitForFunction(() => [...document.querySelectorAll('#limcode-mobile-drawer .item .title')].every((title) => title.textContent.includes('project-b')));

  failures.create = true;
  t.after(() => { failures.create = false; });
  const message = new Promise((resolve) => page.once('dialog', (dialog) => { resolve(dialog.message()); dialog.dismiss(); }));
  await drawer(page).locator('[data-new]').tap();
  assert.equal(await message, '新建对话失败：项目不属于当前工作区');
  assert.deepEqual(created.at(-1), { projectFolderUri: PROJECT_B });
  assert.equal(await drawerOpen(page), true, '失败时留在列表');
  failures.create = false;

  await drawer(page).locator('[data-close]').tap();
  await waitClosed(page);
  failures.page = true;
  t.after(() => { failures.page = false; });
  await page.locator('#limcode-mobile-bar [data-menu]').tap();
  await drawer(page).getByText('读取对话失败：读取历史失败').waitFor();
  failures.page = false;
  await drawer(page).getByRole('button', { name: '重试', exact: true }).tap();
  await drawer(page).locator('.item').first().waitFor();
  assert.equal(await drawer(page).getByText('读取对话失败').count(), 0);

  await drawer(page).locator('[data-new]').tap();
  await waitClosed(page);
  assert.deepEqual(created.at(-1), { projectFolderUri: PROJECT_B });
  assert.equal(opened.at(-1), 'c1');
});
