import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { createRequire } from 'node:module';
import test from 'node:test';
import { chromium } from 'playwright';

const require = createRequire(import.meta.url);
const { createEmptyClientState } = require('../dist/extension/shared/clientStateSchema.js');
const { BridgeMessageType: T } = require('../dist/extension/shared/protocol.js');

// Exercise the packaged Vue application and real browser events. The host is synthetic:
// backend persistence, CAS and wire bodies are covered by session-thinking-runtime.test.mjs.
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
      window.replaceHost = () => { host = 'host-b'; session = 'edit-b'; emit(T.Hello, { meta: { kind: 'mainPanel', conversationId: 'conversation' } }); };
    }, { T, state: createEmptyClientState() });
    await page.goto(`http://127.0.0.1:${server.address().port}`);
    const thinking = page.locator('.session-thinking-dropdown');
    await thinking.getByRole('button').filter({ hasText: '默认 · high' }).waitFor();
    await page.locator('textarea').fill('browser regression message');
    await thinking.getByRole('button').click();
    await page.getByRole('option', { name: 'medium', exact: true }).click();
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
    await thinking.getByRole('button').filter({ hasText: '默认 · high' }).waitFor();
    await send.click();
    await page.waitForFunction(T => window.requests.some(r => r.type === T.TurnStart), T);
    const requests = await page.evaluate(() => window.requests);
    const sent = requests.find(r => r.type === T.TurnStart);
    assert.equal(sent.payload.model, undefined, 'a thinking-only profile must not pin its old model');
    assert.equal(sent.clientId, 'host-b');
    assert.equal(requests.filter(r => r.type === T.ModelProfileScopeSet).length, 1, 'recovery must not silently replay failed writes');
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
// Only the host feed and message bodies are stubbed; varying row heights prevent a
// fixed scrollTop or message-count formula from accidentally passing this test.
test('history click keeps the visible message anchored after the production Vue list updates', async () => {
  const { createServer: createViteServer } = await import('vite');
  const fixture = `
    import { reactive, ref } from 'vue';
    const rows = (from, count) => Array.from({length:count}, (_, i) => ({id:'message-'+(from+i), seq:from+i, role:'user', content:{role:'user',parts:[{text:'synthetic history'}]}, createdAt:from+i, status:'completed', conversationId:'scroll-conversation'}));
    export const projection = ref({messages:rows(101,30), absoluteFloorByMessageId:{}, terminationByMessageId:{}, turnIdByMessageId:{}, interactionByToolCallId:{}, messageRevisionIdByMessageId:{}, modelRequestIdByMessageId:{}, toolCalls:[]});
    export const conversationId = ref('scroll-conversation');
    export const feed = reactive({records:{}, details:{}, transientModelRequests:{}, historyConversationId:'scroll-conversation', historyHasMore:true, historyLoading:false, historyLoadedPages:1,
      requestEarlierHistory(){this.historyLoading=true;return true;}, setPinnedDetailKeys(){}, requestDetail(){} });
    export const useReliableConversation = () => ({feed, conversationId, projection, ensureDetails(){}});
    export const useChat = () => ({conversationAction:ref(null), conversationActionPending:ref(false), conversationActionLabel:ref(null), conversationActionNotice:ref(null), forkPendingTargetIds:ref(new Set()), currentAuthoritySelection:()=>({})});
    export const useGlobalSettingsStore = () => ({llmProviderConfigs:{configs:[]},llm:{}});
    export const useModelProfileStore = () => ({effectiveFor:()=>({})});
    export const useReliableTimelinePresentationStore = () => ({isSuppressed:()=>false});
    window.fulfillEarlier = () => {projection.value={...projection.value,messages:rows(81,50)};feed.historyLoading=false;feed.historyLoadedPages++;};
  `;
  const stubs = ['useReliableConversation', 'useChat', 'useGlobalSettingsStore', 'useModelProfileStore', 'useReliableTimelinePresentationStore'];
  const server = await createViteServer({
    configFile: path.resolve('vite.config.ts'),
    server: { host: '127.0.0.1', port: 0, strictPort: false, hmr: false },
    plugins: [{
      name: 'history-scroll-browser-fixture', enforce: 'pre',
      resolveId(id) { if (id.startsWith('virtual:scroll-')) return '\0' + id; },
      load(id) {
        if (id === '\0virtual:scroll-fixture') return fixture;
        if (id === '\0virtual:scroll-body') return `import {h} from 'vue';export default {props:['message'],setup:p=>()=>p.message?h('div',{style:{height:(91+p.message.seq%3*19)+'px'}},p.message.id):null};`;
      },
      transform(code, id) {
        if (!id.endsWith('/ReliableMessageList.vue')) return;
        for (const hook of stubs) code = code.replace(new RegExp("from '(@webview/[^']+/" + hook + ")'", 'g'), "from 'virtual:scroll-fixture'");
        code = code.replace(/from '\.\/[^']+\.vue'/g, "from 'virtual:scroll-body'");
        return code;
      },
      configureServer(vite) {
        vite.middlewares.use('/history-scroll-fixture', async (_request, response) => {
          response.setHeader('Content-Type', 'text/html');
          response.end(await vite.transformIndexHtml('/history-scroll-fixture', `<link rel="icon" href="data:,"><div id="app"></div><script type="module">
            import {createApp,h,ref} from 'vue';
            import List from '/src/components/conversation/ReliableMessageList.vue';
            createApp({setup(){const scroller=ref(null);return()=>h('div',{id:'scroll-fixture',ref:scroller,style:'height:400px;overflow:auto;overflow-anchor:none'},[h(List,{scroller:scroller.value,followLatest:false})]);}}).mount('#app');
          </script>`));
        });
      }
    }]
  });
  let browser;
  const errors = [];
  try {
    await server.listen();
    browser = await chromium.launch({ headless: true, ...(process.env.LIMCODE_TEST_BROWSER_PATH ? { executablePath: process.env.LIMCODE_TEST_BROWSER_PATH } : {}) });
    const page = await browser.newPage();
    page.setDefaultTimeout(10000);
    page.on('pageerror', error => { errors.push(error.message); console.error('History fixture error:', error.message); });
    await page.goto(`http://127.0.0.1:${server.httpServer.address().port}/history-scroll-fixture`);
    const scroller = page.locator('#scroll-fixture');
    const row = id => page.locator(`.reliable-message-row[data-timeline-row-key="${id}"]`);
    const offset = target => target.evaluate(element => element.getBoundingClientRect().top - document.querySelector('#scroll-fixture').getBoundingClientRect().top);
    await row('message-101').waitFor();
    const before = await offset(row('message-101'));
    await page.getByRole('button', { name: '显示更早内容', exact: true }).click();
    await page.getByRole('button', { name: '正在加载更早内容', exact: true }).waitFor();
    await page.evaluate(() => window.fulfillEarlier());
    await row('message-81').waitFor();
    await page.waitForFunction(expected => {
      const row = document.querySelector('.reliable-message-row[data-timeline-row-key="message-101"]');
      return Math.abs(row.getBoundingClientRect().top - document.querySelector('#scroll-fixture').getBoundingClientRect().top - expected) < 1;
    }, before);
    assert.ok((await scroller.evaluate(element => element.scrollTop)) > 1000);
    // The other branch of showEarlierSegment uses already loaded rows, without a feed page.
    await page.getByRole('button', { name: '显示较新内容', exact: true }).click();
    await scroller.evaluate(element => { element.scrollTop = 0; });
    const loadedBefore = await offset(row('message-101'));
    await page.getByRole('button', { name: '显示更早内容（前方 20 个步骤）', exact: true }).click();
    await row('message-81').waitFor();
    assert.ok(Math.abs(await offset(row('message-101')) - loadedBefore) < 1);
    assert.deepEqual(errors, []);
  } finally {
    await browser?.close();
    await server.close();
  }
});
