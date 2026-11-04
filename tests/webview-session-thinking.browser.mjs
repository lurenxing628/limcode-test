import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { createRequire } from 'node:module';
import test from 'node:test';
import { chromium } from 'playwright';
import { createBrowserFixtureServer } from './reliable-kernel/browser-fixture-server.mjs';
import { createHistoryScrollFixture } from './reliable-kernel/collaboration-reading-browser-fixture.mjs';

const require = createRequire(import.meta.url);
const { createEmptyClientState } = require('../dist/extension/shared/clientStateSchema.js');
const { BridgeMessageType: T } = require('../dist/extension/shared/protocol.js');

// Exercise the packaged Vue application and real browser events. The host is synthetic:
// Backend persistence, CAS and wire bodies are covered by configuration-runtime-smoke.test.mjs.
test('built chat can read thinking, recover an expired save session, and send with inherited model', async () => {
  const root = path.resolve('dist/webview');
  const server = createServer(async (req, res) => {
    const file = path.resolve(root, '.' + (new URL(req.url, 'http://localhost').pathname === '/' ? '/index.html' : new URL(req.url, 'http://localhost').pathname));
    if (!file.startsWith(root + path.sep)) { res.writeHead(403).end(); return; }
    try {
      res.setHeader('Content-Type', ({ '.js': 'text/javascript', '.css': 'text/css', '.html': 'text/html' })[path.extname(file)] ?? 'application/octet-stream');
      res.end(await readFile(file));
    } catch { res.writeHead(404).end(); }
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  let browser, page;
  const errors = [];
  try {
    browser = await chromium.launch({ headless: true, ...(process.env.LIMCODE_TEST_BROWSER_PATH ? { executablePath: process.env.LIMCODE_TEST_BROWSER_PATH } : {}) });
    page = await browser.newPage();
    page.setDefaultTimeout(10000);
    page.on('pageerror', error => errors.push(error.message));
    await page.addInitScript(({ T, state }) => {
      let host = 'host-a', seq = 0, session = 'edit-a';
      const model = { providerConfigId: 'provider', provider: 'openai-compatible', model: 'gpt-5.6-terra' };
      const provider = { id: 'provider', name: 'Test channel', provider: model.provider, model: model.model,
        baseUrl: 'https://example.invalid/v1', apiKey: '', systemPromptPrefix: '', stream: true, toolCallFormat: 'function-call',
        promptCache: { enabled: false },
        models: [{ id: model.model, name: model.model }], modelConfigs: [], generationConfig: { thinkingConfig: { thinkingLevel: 'high' } }, createdAt: 1, updatedAt: 1 };
      let profile = { id: 'profile', name: 'thinking only', ...model, model: 'o3', inheritModel: true, thinkingOverride: { kind: 'openai-effort', value: 'low' } };
      const emit = (type, payload, correlationId) => window.postMessage({ id: crypto.randomUUID(), clientId: host, type, payload, correlationId }, '*');
      const observe = () => ({ scopeKind: 'conversation', scopeId: 'conversation', authorityId: 'root', sessionId: session,
        sequence: ++seq, revision: `r${seq}`, outcome: 'observed', effectiveModel: model, profile,
        link: { id: 'link', scopeKind: 'conversation', scopeId: 'conversation', modelProfileId: 'profile', role: 'active', createdAt: 1, updatedAt: 1 },
        profileState: profile.thinkingOverride ? 'overridden' : 'default' });
      window.requests = [];
      window.failSave = true;
      window.acquireVsCodeApi = () => ({ getState() {}, setState() {}, postMessage(message) {
        window.requests.push(structuredClone(message));
        queueMicrotask(() => {
          const p = message.payload;
          if (message.type === T.Ready) {
            emit(T.Hello, { meta: { kind: 'mainPanel', conversationId: 'conversation' } });
            emit(T.ConfigurationSnapshot, { state, loadedAt: 1 });
            window.postMessage({ type: 'reliable-kernel.snapshot', sessionId: `feed-${host}`, hostBootId: host,
              messageSeq: '1', snapshotCommitSeq: '1', projections: { activeConversationWindow: { conversationId: 'conversation' },
                conversations: [{ id: 'conversation', title: 'Browser regression', status: 'active', created_at: 1, updated_at: 1 }] } }, '*');
          } else if (message.type === T.GlobalSettingsGet) {
            const settings = p.section === 'llm' ? { activeProviderConfigId: 'provider' }
              : p.section === 'llmProviderConfigs' ? { configs: [provider] }
              : p.section === 'llmCompressionConfigs' ? { configs: [] } : {};
            emit(T.GlobalSettingsSnapshot, { section: p.section, settings, revision: 'settings', loadedAt: 1 }, message.id);
          } else if (message.type === T.ModelProfileScopeRead) {
            if (p.afterRequestId) {
              emit(T.ModelProfileScopeSnapshot, { ...observe(), outcome: 'uncertain', revision: '', error: '编辑会话已失效' }, message.id);
            } else {
              if (p.renewSession) session = 'edit-renewed';
              emit(T.ModelProfileScopeSnapshot, observe(), message.id);
            }
          } else if (message.type === T.ModelProfileScopeSet) {
            if (window.failSave) {
              emit(T.Error, { requestType: message.type, message: '保存连接中断' }, message.id);
            } else {
              profile = { ...profile, ...model, thinkingOverride: p.thinkingOverride };
              emit(T.ModelProfileScopeSnapshot, { ...observe(), outcome: 'committed', operation: p.operation, expectedRevision: p.expectedRevision }, message.id);
            }
          }
        });
      } });
      window.replaceHost = (next = 'host-b') => { host = next; session = 'edit-b'; emit(T.Hello, { meta: { kind: 'mainPanel', conversationId: 'conversation' } }); };
    }, { T, state: createEmptyClientState() });
    await page.goto(`http://127.0.0.1:${server.address().port}`, { waitUntil: 'domcontentloaded' });
    const thinking = page.locator('.session-thinking-dropdown');
    await thinking.getByRole('button').filter({ hasText: '思考：高' }).waitFor();
    await page.locator('textarea').fill('browser regression message');
    await thinking.getByRole('button').click();
    await page.getByRole('option', { name: '中（medium）', exact: true }).click();
    await page.getByText('保存连接中断', { exact: false }).waitFor();
    const send = page.locator('button.composer-send');
    await send.click();
    assert.equal(await page.evaluate(T => window.requests.filter(r => r.type === T.TurnStart).length, T), 0);
    await page.getByRole('button', { name: '重试', exact: true }).click();
    await page.getByText('编辑会话已失效', { exact: false }).waitFor();
    await page.getByRole('button', { name: '重试', exact: true }).click();
    await page.waitForFunction(T => window.requests.some(r => r.type === T.ModelProfileScopeRead && r.payload.renewSession), T);
    await page.waitForFunction(() => !document.querySelector('.session-thinking-error'));
    await page.evaluate(() => window.replaceHost());
    await page.waitForFunction(T => window.requests.some(r => r.type === T.ModelProfileScopeRead && r.clientId === 'host-b'), T);
    await thinking.getByRole('button').filter({ hasText: '思考：高' }).waitFor();
    await send.click();
    await page.waitForFunction(T => window.requests.some(r => r.type === T.TurnStart), T);
    const requests = await page.evaluate(() => window.requests);
    const sent = requests.find(r => r.type === T.TurnStart);
    assert.equal(sent.payload.model, undefined, 'a thinking-only profile must not pin its old model');
    assert.equal(sent.clientId, 'host-b');
    assert.equal(requests.filter(r => r.type === T.ModelProfileScopeSet).length, 1, 'recovery must not silently replay failed writes');
    await page.setViewportSize({ width: 1200, height: 800 });
    const expanded = await page.evaluate(() => {
      const selectors = [...document.querySelectorAll('.composer-meta .composer-meta-dropdown, .composer-meta .session-thinking-dropdown')];
      return selectors.map((selector, index) => {
        const label = selector.querySelector('.settings-dropdown-label');
        const before = selector.getBoundingClientRect().width;
        label.textContent = `比较长的配置名称示例${index}继续显示完整名称`;
        return { before, after: selector.getBoundingClientRect().width, visible: label.clientWidth, content: label.scrollWidth };
      });
    });
    assert.ok(expanded.length >= 3, '工作流、渠道、思考强度下拉框必须在输入栏中');
    assert.ok(expanded.some(item => item.after > item.before + 20), '按钮宽度应随选中名称增长');
    assert.ok(expanded.every(item => item.visible + 1 >= item.content), '宽面板应完整显示选中名称');
    await page.setViewportSize({ width: 360, height: 800 });
    const narrow = await page.evaluate(() => {
      const meta = document.querySelector('.composer-meta').getBoundingClientRect();
      return [...document.querySelectorAll('.composer-meta .composer-meta-dropdown, .composer-meta .session-thinking-dropdown')]
        .map(selector => { const rect = selector.getBoundingClientRect(); return rect.left >= meta.left - 1 && rect.right <= meta.right + 1; });
    });
    assert.ok(narrow.every(Boolean), '窄窗口可换行，但下拉框不能越出输入栏');
    const keptDraft = await page.locator('textarea').inputValue();
    await page.evaluate(T => window.postMessage({ id: 'runtime-failure', clientId: 'host-b', type: T.Error,
      payload: { code: 'runtime_unavailable', message: '运行连接已停止：测试心跳失败，请重载窗口。' } }, '*'), T);
    await page.locator('.composer-runtime-error').waitFor();
    assert.equal(await send.isDisabled(), true);
    assert.equal(await page.locator('textarea').inputValue(), keptDraft);
    await page.evaluate(T => window.postMessage({ id: 'late-hello', clientId: 'host-b', type: T.Hello,
      payload: { meta: { kind: 'mainPanel', conversationId: 'conversation' } } }, '*'), T);
    assert.ok(await page.locator('.composer-runtime-error').isVisible(), '同一故障 Host 的迟到 Hello 不恢复可用状态');
    await page.evaluate(() => window.replaceHost('host-c'));
    await page.locator('.composer-runtime-error').waitFor({ state: 'hidden' });
    assert.deepEqual(errors, []);
  } catch (error) {
    console.error('Browser diagnostics:', errors, await page?.locator('body').innerText(), await page?.evaluate(() => window.requests));
    throw error;
  } finally {
    await browser?.close();
    await new Promise(resolve => server.close(resolve));
  }
});

// Mount the production list and exercise its actual click handler/watch/DOM update.
// Host admission and card data are synthetic. MessageItem, body hydration, content rendering
// and the reading viewport use production components; bodies arrive after history metadata.
test('history click keeps the visible message anchored after the production Vue list updates', async () => {
  const server = await createHistoryScrollFixture();
  let browser;
  const errors = [];
  try {
    await server.listen();
    browser = await chromium.launch({ headless: true, ...(process.env.LIMCODE_TEST_BROWSER_PATH ? { executablePath: process.env.LIMCODE_TEST_BROWSER_PATH } : {}) });
    const page = await browser.newPage();
    page.setDefaultTimeout(10000);
    page.on('pageerror', error => { errors.push(error.message); console.error('History fixture error:', error.message); });
    await page.addInitScript(() => { window.acquireVsCodeApi = () => ({ postMessage() {}, getState() {}, setState() {} }); });
    const url = `http://127.0.0.1:${server.httpServer.address().port}/history-scroll-fixture`;
    const scroller = page.locator('#scroll-fixture');
    const row = id => page.locator(`.reliable-message-row[data-timeline-row-key="${id}"]`);
    const offset = target => target.evaluate(element => element.getBoundingClientRect().top - document.querySelector('#scroll-fixture').getBoundingClientRect().top);
    const openReadingHistory = async () => {
      await page.goto(url, { waitUntil: 'domcontentloaded' });
      await row('message-129').waitFor();
      await scroller.evaluate(element => { element.dispatchEvent(new WheelEvent('wheel', { deltaY: -100, bubbles: true })); element.scrollTop = 0; });
      await page.waitForFunction(() => !window.fixtureSticky.stickyToBottom.value && document.querySelector('#scroll-fixture').scrollTop === 0);
      await row('message-101').waitFor();
    };
    await openReadingHistory();
    const before = await offset(row('message-101'));
    await page.getByRole('button', { name: '显示更早内容', exact: true }).click();
    await page.getByRole('button', { name: '正在加载更早内容', exact: true }).waitFor();
    await page.evaluate(() => window.fulfillEarlier());
    await page.getByRole('button', { name: '正在加载更早内容', exact: true }).waitFor();
    await page.evaluate(() => window.fulfillCollaboration());
    // The new card occupies one of the twenty earlier timeline positions.
    await row('message-82').waitFor();
    await page.locator('[data-timeline-row-key="collaboration:card-95"]').waitFor();
    await page.waitForFunction(expected => {
      const row = document.querySelector('.reliable-message-row[data-timeline-row-key="message-101"]');
      return Math.abs(row.getBoundingClientRect().top - document.querySelector('#scroll-fixture').getBoundingClientRect().top - expected) < 1;
    }, before);
    const metadataHeight = await scroller.evaluate(element => element.scrollHeight);
    await page.evaluate(() => window.hydrateEarlier());
    await page.locator('[data-message-id="message-82"] .rc-text').waitFor();
    await page.waitForFunction(expected => {
      const row = document.querySelector('.reliable-message-row[data-timeline-row-key="message-101"]');
      return Math.abs(row.getBoundingClientRect().top - document.querySelector('#scroll-fixture').getBoundingClientRect().top - expected) < 1;
    }, before);
    assert.ok((await scroller.evaluate(element => element.scrollHeight)) > metadataHeight + 500);
    // The other branch of showEarlierSegment uses already loaded rows, without a feed page.
    await page.getByRole('button', { name: '显示较新内容', exact: true }).click();
    await scroller.evaluate(element => { element.dispatchEvent(new WheelEvent('wheel', { deltaY: -100, bubbles: true })); element.scrollTop = 0; });
    const loadedBefore = await offset(row('message-101'));
    await page.getByRole('button', { name: '显示更早内容', exact: true }).click();
    await row('message-82').waitFor();
    assert.ok(Math.abs(await offset(row('message-101')) - loadedBefore) < 1);

    await openReadingHistory();
    await page.getByRole('button', { name: '显示更早内容', exact: true }).click();
    await page.getByRole('button', { name: '正在加载更早内容', exact: true }).waitFor();
    await scroller.hover();
    await page.mouse.wheel(0, 700);
    await page.waitForFunction(() => document.querySelector('#scroll-fixture').scrollTop >= 600);
    const moved = await scroller.evaluate(element => {
      const bounds = element.getBoundingClientRect();
      const target = [...element.querySelectorAll('[data-timeline-row-key]')].find(candidate => {
        const rect = candidate.getBoundingClientRect(); return rect.bottom > bounds.top && rect.top < bounds.bottom;
      });
      return { id: target.dataset.timelineRowKey, offset: target.getBoundingClientRect().top - bounds.top };
    });
    await page.evaluate(() => { window.fulfillEarlier(); window.fulfillCollaboration(); });
    await page.waitForFunction(expected => {
      const scroller = document.querySelector('#scroll-fixture');
      const target = [...scroller.querySelectorAll('[data-timeline-row-key]')].find(candidate => candidate.dataset.timelineRowKey === expected.id);
      return target && Math.abs(target.getBoundingClientRect().top - scroller.getBoundingClientRect().top - expected.offset) < 1;
    }, moved);
    await page.evaluate(() => window.hydrateEarlier());
    await page.waitForFunction(expected => {
      const scroller = document.querySelector('#scroll-fixture');
      const target = [...scroller.querySelectorAll('[data-timeline-row-key]')].find(candidate => candidate.dataset.timelineRowKey === expected.id);
      return target && Math.abs(target.getBoundingClientRect().top - scroller.getBoundingClientRect().top - expected.offset) < 1;
    }, moved);

    await openReadingHistory();
    await page.getByRole('button', { name: '显示更早内容', exact: true }).click();
    await page.getByRole('button', { name: '正在加载更早内容', exact: true }).waitFor();
    await scroller.focus();
    await page.keyboard.press('End');
    await page.waitForFunction(() => window.fixtureSticky.stickyToBottom.value);
    await page.evaluate(() => { window.fulfillEarlier(); window.fulfillCollaboration(); });
    await row('message-130').waitFor();
    await page.evaluate(() => window.hydrateEarlier());
    await page.waitForFunction(() => {
      const scroller = document.querySelector('#scroll-fixture');
      return window.fixtureSticky.stickyToBottom.value && scroller.querySelector('[data-timeline-row-key="message-130"]')
        && Math.abs(scroller.scrollHeight - scroller.clientHeight - scroller.scrollTop) < 1;
    });
    assert.deepEqual(errors, []);
  } finally {
    await browser?.close();
    await server.close();
  }
});


async function withCollaborationHistoryBrowser(run) {
  const server = await createHistoryScrollFixture();
  let browser;
  const errors = [];
  try {
    await server.listen();
    browser = await chromium.launch({ headless: true, ...(process.env.LIMCODE_TEST_BROWSER_PATH ? { executablePath: process.env.LIMCODE_TEST_BROWSER_PATH } : {}) });
    const page = await browser.newPage();
    page.setDefaultTimeout(10000);
    page.on('pageerror', error => errors.push(error.message));
    await page.addInitScript(() => {
      window.acquireVsCodeApi = () => ({
        postMessage(message) {
          if (message.type === 'reliable-kernel.collaboration-history-request') window.fixtureRequests?.push(structuredClone(message));
        }, getState() {}, setState() {}
      });
    });
    const base = `http://127.0.0.1:${server.httpServer.address().port}/history-scroll-fixture`;
    const open = async (count = 80, cards = [105], realFeed = false) => {
      await page.goto(`${base}?search=1&count=${count}&cards=${cards.join(',')}${realFeed ? '&real-feed=1' : ''}`, { waitUntil: 'domcontentloaded' });
      await page.waitForFunction(last => {
        const scroller = document.querySelector('#scroll-fixture');
        return window.fixtureSticky?.stickyToBottom.value && scroller?.querySelector(`[data-timeline-row-key="message-${last}"]`)
          && Math.abs(scroller.scrollHeight - scroller.clientHeight - scroller.scrollTop) < 1;
      }, 100 + count);
      if (realFeed) assert.equal(await page.evaluate(() => window.fixtureFeed.collaborationHistoryError), null,
        '夹具初始页必须通过真实协作分页准入');
    };
    await run({ page, open });
    assert.deepEqual(errors, []);
  } finally {
    try { await browser?.close(); }
    finally { await server.close(); }
  }
}

async function assertCollaborationHit(page, target, direction = 'after') {
  await page.waitForFunction(sequence => {
    const scroller = document.querySelector('#scroll-fixture');
    const row = scroller.querySelector(`[data-timeline-row-key="collaboration:card-${sequence}"]`);
    const card = row?.querySelector('article.collaboration-card');
    if (!card) return false;
    const viewport = scroller.getBoundingClientRect(), rect = row.getBoundingClientRect();
    const cardRect = card.getBoundingClientRect();
    return Math.abs(rect.top - viewport.top) < 1 && cardRect.height > 0
      && cardRect.bottom > viewport.top && cardRect.top < viewport.bottom
      && cardRect.left >= viewport.left && cardRect.right <= viewport.right;
  }, target);
  const row = page.locator(`[data-timeline-row-key="collaboration:card-${target}"]`);
  assert.equal(await row.locator('.collaboration-card-preview').innerText(), `card-${target}`, '命中必须由真实协作卡片呈现');
  assert.equal(await page.evaluate(() => window.fixtureSticky.stickyToBottom.value), false);
  assert.match(await page.locator(`[data-history-direction="${direction}"]`).getByRole('status').innerText(),
    direction === 'before' ? /已找到更早的协作记录/ : /已找到较新的协作记录/);
  assert.equal(await page.evaluate(() => window.fixtureRetainedCards.at(-1)), `card-${target}`, '保留页必须来自实际命中，不是挂载卡片的中位数');
}

async function settleHistoryLayout(page) {
  await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
}

test('collaboration after aligns the hit in overlapping and completely replaced reading segments', async () => {
  await withCollaborationHistoryBrowser(async ({ page, open }) => {
    for (const count of [80, 160]) {
      await open(count);
      const previousRows = await page.locator('[data-timeline-row-key]').evaluateAll(rows => rows.map(row => row.dataset.timelineRowKey));
      await page.getByRole('button', { name: '查找较新协作记录', exact: true }).click();
      assert.deepEqual(await page.evaluate(() => window.fixtureRequests), [{ id: 'scroll-conversation', direction: 'after' }]);
      await page.evaluate(() => window.fulfillSearch([105, 130]));
      await assertCollaborationHit(page, 130);
      const currentRows = await page.locator('[data-timeline-row-key]').evaluateAll(rows => rows.map(row => row.dataset.timelineRowKey));
      assert.ok(currentRows.length <= 30, '查找不能用无限挂载来绕过分段定位');
      assert.equal(currentRows.some(id => previousRows.includes(id)), count === 80,
        count === 80 ? '80 条消息场景必须保留重叠段' : '160 条消息场景必须完全换段');
    }
  });
});

test('collaboration after keeps the hit and success feedback beyond 800ms and repeated late bodies', async () => {
  await withCollaborationHistoryBrowser(async ({ page, open }) => {
    await open(80, [164, 165, 166, 167, 168]);
    const scroller = page.locator('#scroll-fixture');
    await page.getByRole('button', { name: '查找较新协作记录', exact: true }).click();
    // Cross the old 800ms reattach boundary, not a machine-dependent performance threshold.
    await page.waitForTimeout(900);
    await page.evaluate(() => window.fulfillSearch([164, 165, 166, 167, 168, 170]));
    await assertCollaborationHit(page, 170);
    assert.ok(await page.locator('[data-timeline-row-key]').count() <= 30);
    for (const repetitions of [300, 500]) {
      await page.waitForTimeout(900);
      const previousHeight = await scroller.evaluate(element => element.scrollHeight);
      await page.evaluate(repetitions => window.hydrateBefore(170, repetitions), repetitions);
      await page.waitForFunction(height => document.querySelector('#scroll-fixture').scrollHeight > height, previousHeight);
      await settleHistoryLayout(page);
      await assertCollaborationHit(page, 170);
    }
    // Explicit user navigation, rather than content growth, gives following the tail back control.
    await scroller.focus();
    await page.keyboard.press('End');
    await page.waitForFunction(() => {
      const scroller = document.querySelector('#scroll-fixture');
      return window.fixtureSticky.stickyToBottom.value && scroller.querySelector('[data-timeline-row-key="message-180"]')
        && Math.abs(scroller.scrollHeight - scroller.clientHeight - scroller.scrollTop) < 1;
    });
  });
});

test('collaboration after controls block ordinary loading and show stoppable, retryable feedback at the bottom', async () => {
  await withCollaborationHistoryBrowser(async ({ page, open }) => {
    await open(29);
    assert.equal(await page.getByRole('button', { name: '显示更早内容', exact: true }).count(), 0,
      '只有协作历史可继续时，不显示普通历史翻页入口');
    await open();
    const before = page.locator('[data-history-direction="before"]');
    const controls = page.locator('[data-history-direction="after"]');
    const newer = controls.getByRole('button', { name: '查找较新协作记录', exact: true });
    await page.evaluate(() => { window.fixtureFeed.historyLoading = true; });
    assert.equal(await before.getByRole('button', { name: '查找更早协作记录', exact: true }).isDisabled(), true);
    assert.equal(await newer.isDisabled(), true);
    assert.equal(await page.evaluate(() => window.fixtureRequests.length), 0);
    await page.evaluate(() => { window.fixtureFeed.historyLoading = false; });

    // Record geometry before Playwright's next click can auto-scroll an offscreen control.
    const feedback = [];
    const recordFeedback = async (locator, stage) => {
      await settleHistoryLayout(page);
      feedback.push(await locator.evaluate((element, stage) => {
        const viewport = document.querySelector('#scroll-fixture').getBoundingClientRect();
        const rect = element.getBoundingClientRect();
        return { stage, text: element.textContent, direction: element.closest('[data-history-direction]')?.dataset.historyDirection,
          top: rect.top - viewport.top, bottom: rect.bottom - viewport.top, viewportHeight: viewport.height,
          fullyVisible: rect.height > 0 && rect.top >= viewport.top - 1 && rect.bottom <= viewport.bottom + 1
            && rect.left >= viewport.left && rect.right <= viewport.right };
      }, stage));
    };
    await newer.click();
    const stop = controls.getByRole('button', { name: '停止查找', exact: true });
    await recordFeedback(stop, '停止按钮');
    await recordFeedback(controls.getByRole('status'), '查找进度');
    assert.equal(await before.getByRole('status').count(), 0, 'after 进度不能只显示在顶部');
    await stop.click();
    assert.match(await controls.getByRole('status').innerText(), /已停止查找.*正在接收已发出的页面/);
    assert.equal(await controls.getByRole('button', { name: '正在接收协作记录', exact: true }).isDisabled(), true);
    await recordFeedback(controls.getByRole('status'), '停止后的在途页面提示');
    const stoppedRows = await page.locator('[data-timeline-row-key]').evaluateAll(rows => rows.map(row => row.dataset.timelineRowKey));
    await page.evaluate(() => window.fulfillSearch([105, 130], true));
    await settleHistoryLayout(page);
    assert.equal(await page.evaluate(() => window.fixtureRequests.length), 1, '停止后不继续扫描');
    assert.deepEqual(await page.locator('[data-timeline-row-key]').evaluateAll(rows => rows.map(row => row.dataset.timelineRowKey)), stoppedRows,
      '停止后的回包可以准入，但不能重新定位阅读段');
    assert.equal(await page.locator('[data-timeline-row-key="message-180"]').count(), 1);
    assert.equal(await page.locator('[data-timeline-row-key="collaboration:card-130"]').count(), 0);
    await recordFeedback(controls.getByRole('status'), '停止完成');

    await newer.click();
    assert.equal(await page.evaluate(() => window.fixtureRequests.length), 2, '停止完成后可再次查找');
    await page.evaluate(() => { window.fixtureFeed.collaborationHistoryLoading = false; window.fixtureFeed.collaborationHistoryError = '测试读取失败'; });
    await controls.getByRole('alert').waitFor();
    await recordFeedback(controls.getByRole('alert'), '读取失败');
    await recordFeedback(controls.getByRole('status'), '失败后的重试提示');
    assert.equal(await before.getByRole('alert').count(), 0, 'after 错误不能只显示在顶部');
    assert.equal(await newer.isEnabled(), true);
    await newer.click();
    assert.equal(await page.evaluate(() => window.fixtureRequests.length), 3, '失败后必须真的能发起重试，而不只按钮启用');
    assert.ok((await page.evaluate(() => window.fixtureRequests)).every(request => request.direction === 'after'));
    assert.equal(await controls.getByRole('alert').count(), 0);
    await page.evaluate(() => window.fulfillSearch([105, 130, 140]));
    await assertCollaborationHit(page, 140);
    assert.ok(feedback.every(item => item.direction === 'after' && item.fullyVisible),
      `底部进度、停止与失败反馈必须在当前视口可读：${JSON.stringify(feedback)}`);
  });
});


test('collaboration before uses the same hit anchor and direction-local feedback', async () => {
  await withCollaborationHistoryBrowser(async ({ page, open }) => {
    for (const count of [80, 160]) {
      await open(count, [170]);
      await page.getByRole('button', { name: '查找更早协作记录', exact: true }).click();
      assert.deepEqual(await page.evaluate(() => window.fixtureRequests.map(request => request.direction)), ['before']);
      const controls = page.locator('[data-history-direction="before"]');
      await controls.getByRole('button', { name: '停止查找', exact: true }).waitFor();
      assert.equal(await page.locator('[data-history-direction="after"]').getByRole('status').count(), 0);
      await page.evaluate(() => window.fulfillSearch([130, 170]));
      await assertCollaborationHit(page, 130, 'before');
      assert.ok(await page.locator('[data-timeline-row-key]').count() <= 30);
      await page.evaluate(() => window.hydrateBefore(130));
      await settleHistoryLayout(page);
      await assertCollaborationHit(page, 130, 'before');
    }
  });
});

test('real Feed keeps the terminal frontier while the browser reads an older card and scans empty pages', async () => {
  await withCollaborationHistoryBrowser(async ({ page, open }) => {
    await open(80, [105], true);
    await page.getByRole('button', { name: '查找较新协作记录', exact: true }).click();
    assert.equal(await page.evaluate(() => window.fixtureRequests[0].cursor.afterExchangeSeq), '105');
    await page.evaluate(() => window.fulfillFeedHistory([130], { before: 130, after: 130, hasMoreBefore: true, hasMoreAfter: false }));
    await assertCollaborationHit(page, 130);
    assert.equal(await page.evaluate(() => window.fixtureFeed.collaborationHistoryHasMoreAfter), false);

    const olderCard = page.locator('[data-timeline-row-key="collaboration:card-105"]');
    for (let step = 0; step < 4 && !await olderCard.count(); step++) {
      await page.getByRole('button', { name: '显示更早内容', exact: true }).click();
      await settleHistoryLayout(page);
    }
    await olderCard.evaluate(element => {
      const scroller = document.querySelector('#scroll-fixture');
      scroller.dispatchEvent(new WheelEvent('wheel', { deltaY: -1, bubbles: true }));
      // Keep a one-pixel edge of the preceding Message visible, regardless of fractional layout.
      scroller.scrollTop += element.getBoundingClientRect().top - scroller.getBoundingClientRect().top - 1;
    });
    assert.equal(await page.evaluate(() => {
      const scroller = document.querySelector('#scroll-fixture'), viewport = scroller.getBoundingClientRect();
      return [...scroller.querySelectorAll('[data-timeline-row-key]')].find(row => {
        const bounds = row.getBoundingClientRect();
        return bounds.bottom > viewport.top && bounds.top < viewport.bottom;
      })?.dataset.timelineRowKey;
    }), 'message-105', '普通消息的可见边缘不能遮蔽协作选页');
    await page.waitForFunction(() => window.fixtureFeed.collaborationHistoryCurrentPageId === window.fixtureInitialPageId);
    assert.equal(await page.evaluate(() => window.fixtureRetainedCards.at(-1)), 'card-105');
    assert.equal(await page.evaluate(() => window.fixtureFeed.collaborationHistoryNextAfterCursor.afterExchangeSeq), '130');
    assert.equal(await page.evaluate(() => window.fixtureFeed.collaborationHistoryHasMoreAfter), false,
      '真实视口保留旧页不能重新打开已经到达的末页');
    assert.equal(await page.getByRole('button', { name: '查找较新协作记录', exact: true }).count(), 0);

    await page.getByRole('button', { name: '查找更早协作记录', exact: true }).click();
    assert.equal(await page.evaluate(() => window.fixtureRequests.at(-1).cursor.beforeExchangeSeq), '105');
    await page.evaluate(() => window.fulfillFeedHistory([], { before: 104, after: 104, hasMoreBefore: true, hasMoreAfter: true }));
    await page.waitForFunction(() => window.fixtureRequests.length === 3);
    assert.equal(await page.evaluate(() => window.fixtureRequests.at(-1).cursor.beforeExchangeSeq), '104');
    await page.evaluate(() => window.fulfillFeedHistory([], { before: 103, after: 103, hasMoreBefore: false, hasMoreAfter: true }));
    await page.locator('[data-history-direction="before"]').getByRole('status').filter({ hasText: '没有更早的协作记录' }).waitFor();
    assert.equal(await page.evaluate(() => window.fixtureFeed.collaborationHistoryPages.length), 2,
      '连续空扫描不增加阅读页或淘汰已有卡片');
    assert.deepEqual(await page.evaluate(() => Object.keys(window.fixtureFeed.committedRecords.CollaborationMessage).sort()), ['card-105', 'card-130']);
    assert.equal(await page.evaluate(() => window.fixtureFeed.collaborationHistoryHasMoreAfter), false,
      '空页的反向清单标志不能覆盖已经扫描的末端');
    assert.equal(await page.getByRole('button', { name: '查找较新协作记录', exact: true }).count(), 0);
  });
});

// The host supplies a body and an explicit full-read action; MessageItem, RichContentView,
// text/Markdown rendering, ResizeObserver and the scroll viewport are production components.
test('content blocks stay bounded, preserve a reading anchor, and copy the complete message', async () => {
  const server = await createBrowserFixtureServer({
    dependencies: ['vue', 'pinia', '@tabler/icons-vue', 'markdown-it', 'markdown-it-texmath', 'katex'],
    plugins: [{
      name: 'content-window-browser-fixture',
      configureServer(vite) {
        vite.middlewares.use('/content-window-fixture', async (_request, response) => {
          response.setHeader('Content-Type', 'text/html');
          response.end(await vite.transformIndexHtml('/content-window-fixture', `<link rel="icon" href="data:,"><style>
            body { margin:0; font:16px/22px monospace; } #block-scroller { width:640px; height:420px; overflow:auto; overflow-anchor:none; }
          </style><div id="app"></div><script type="module">
            import {createApp,h,ref} from 'vue'; import {createPinia} from 'pinia';
            import MessageItem from '/src/components/conversation/MessageItem.vue';
            import '/src/theme/tokens.css'; import '/src/theme/base.css';
            import '/src/theme/motion/message.css'; import '/src/theme/motion/content.css';
            const part = i => ({text:'Block '+i+' — '+('readable content '+i+' ').repeat(8+i%5),outputItem:{id:'block-'+i,ordinal:i+32,providerResponseId:'browser-response'}});
            const source=ref({id:'large-message',role:'model',status:'done',createdAt:1,seq:1,conversationId:'browser-content',content:{role:'model',parts:Array.from({length:120},(_,i)=>part(i))}});
            window.completeReads=0;
            window.appendBlockTail=()=>{const parts=source.value.content.parts;source.value={...source.value,content:{role:'model',parts:[...parts.slice(0,-1),{...parts.at(-1),text:parts.at(-1).text+' live extension'}]}};};
            window.prependBlocks=()=>{source.value={...source.value,content:{role:'model',parts:[...Array.from({length:32},(_,i)=>part(i-32)),...source.value.content.parts]}};};
            const thought = i => ({...part(i),thought:true,thoughtDurationMs:5});
            window.showThoughtPage=()=>{source.value={...source.value,content:{role:'model',parts:Array.from({length:32},(_,i)=>thought(i+32))}};};
            window.prependThoughtPage=()=>{source.value={...source.value,content:{role:'model',parts:[...Array.from({length:32},(_,i)=>thought(i)),...source.value.content.parts]}};};
            window.removeThoughtPrefix=()=>{source.value={...source.value,content:{role:'model',parts:source.value.content.parts.slice(48)}};};
            createApp({setup(){const scroller=ref(null);return()=>h('div',{id:'block-scroller',ref:scroller},[h(MessageItem,{message:source.value,scroller:scroller.value,
              loadCompleteContent:async()=>{window.completeReads++;return {role:'model',parts:Array.from({length:160},(_,i)=>part(i))};}})]);}}).use(createPinia()).mount('#app');
          </script>`));
        });
      }
    }]
  });
  let browser, page;
  const errors = [];
  try {
    await server.listen();
    browser = await chromium.launch({ headless: true, ...(process.env.LIMCODE_TEST_BROWSER_PATH ? { executablePath: process.env.LIMCODE_TEST_BROWSER_PATH } : {}) });
    page = await browser.newPage(); page.setDefaultTimeout(10000);
    page.on('pageerror', error => { errors.push(error.message); console.error('Content fixture error:', error.message); });
    await page.addInitScript(() => {
      window.acquireVsCodeApi = () => ({ postMessage() {}, getState() {}, setState() {} });
      Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText: async text => { window.copiedMessage = text; } } });
    });
    await page.goto(`http://127.0.0.1:${server.httpServer.address().port}/content-window-fixture`, { waitUntil: 'domcontentloaded' });
    const blocks = page.locator('[data-content-block-key]');
    await blocks.first().waitFor();
    assert.ok(await blocks.count() <= 32);
    assert.equal(await page.evaluate(() => window.completeReads), 0);
    await page.locator('#block-scroller').evaluate(element => { element.scrollTop = element.scrollHeight / 2; });
    await page.waitForFunction(() => Number(document.querySelector('[data-content-block-key]').textContent.match(/Block (\d+)/)?.[1]) > 20);
    const anchor = await page.evaluate(() => {
      const viewport=document.querySelector('#block-scroller').getBoundingClientRect();
      const block=[...document.querySelectorAll('[data-content-block-key]')].find(element=>element.getBoundingClientRect().bottom>viewport.top && element.getBoundingClientRect().top<viewport.bottom);
      window.heldBlock=block;
      return {key:block.dataset.contentBlockKey,offset:block.getBoundingClientRect().top-viewport.top};
    });
    await page.evaluate(() => window.appendBlockTail());
    await page.waitForFunction(() => document.querySelector('[data-content-block-key]'));
    assert.equal(await page.evaluate(key => [...document.querySelectorAll('[data-content-block-key]')].find(element=>element.dataset.contentBlockKey===key) === window.heldBlock, anchor.key), true);
    await page.evaluate(() => window.prependBlocks());
    await page.waitForFunction(anchor => {
      const block=[...document.querySelectorAll('[data-content-block-key]')].find(element=>element.dataset.contentBlockKey===anchor.key);
      return block && Math.abs(block.getBoundingClientRect().top-document.querySelector('#block-scroller').getBoundingClientRect().top-anchor.offset)<1;
    }, anchor);
    assert.ok(await blocks.count() <= 32);
    await page.locator('.floor-header').hover();
    await page.getByRole('button', { name: '复制消息', exact: true }).click();
    await page.waitForFunction(() => window.copiedMessage?.includes('Block 159'));
    assert.equal(await page.evaluate(() => window.completeReads), 1);
    assert.ok((await page.evaluate(() => window.copiedMessage)).startsWith('Block 0'));
    assert.ok(await blocks.count() <= 32);
    // The resident page can begin in the middle of one continuous reasoning group. Adding an
    // earlier page or releasing its prefix must keep the already expanded production card.
    await page.evaluate(() => window.showThoughtPage());
    await page.getByRole('button', { name: '展开思考内容', exact: true }).first().click();
    await page.locator('.thought-content').waitFor();
    await page.evaluate(() => { window.heldThought = document.querySelector('.thought-panel'); window.prependThoughtPage(); });
    await page.waitForFunction(() => document.querySelector('.thought-content')?.textContent.includes('Block 0'));
    assert.equal(await page.evaluate(() => document.querySelector('.thought-panel') === window.heldThought), true);
    await page.evaluate(() => window.removeThoughtPrefix());
    await page.waitForFunction(() => document.querySelector('.thought-content')?.textContent.startsWith('Block 48'));
    assert.equal(await page.evaluate(() => document.querySelector('.thought-panel') === window.heldThought), true);
    assert.ok(await blocks.count() <= 32);
    assert.deepEqual(errors, []);
  } catch (error) {
    console.error('Content fixture diagnostics:', errors, await page?.evaluate(() => {
      const button = document.querySelector('button[aria-label="复制消息"]');
      const actions = button?.closest('.message-actions'), floor = button?.closest('.message-floor');
      const rect = button?.getBoundingClientRect(), style = actions ? getComputedStyle(actions) : null;
      return { scrollTop: document.querySelector('#block-scroller')?.scrollTop, floorHovered: floor?.matches(':hover'),
        actions: style && { opacity: style.opacity, pointerEvents: style.pointerEvents, top: style.top, right: style.right },
        button: rect?.toJSON(), hit: rect ? document.elementsFromPoint(rect.x + rect.width / 2, rect.y + rect.height / 2)
          .slice(0, 5).map(element => ({ tag: element.tagName, class: element.className, key: element.getAttribute('data-content-block-key') })) : [] };
    }));
    throw error;
  }
  finally { await browser?.close(); await server.close(); }
});
