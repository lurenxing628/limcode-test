import assert from 'node:assert/strict';
import path from 'node:path';
import test from 'node:test';
import { chromium } from 'playwright';

const fixtureHtml = `<!doctype html><html><head><link rel="icon" href="data:,"></head><body>
<div id="app" style="width:720px"></div>
<script>
  window.posted = [];
  window.acquireVsCodeApi = () => ({ postMessage: message => window.posted.push(message), getState() {}, setState() {} });
</script>
<script type="module">
  import '/src/theme/tokens.css';
  import '/src/theme/base.css';
  import { createApp } from 'vue';
  import { createPinia, setActivePinia } from 'pinia';
  import Card from '/src/components/content/parts/FunctionCallPartView.vue';
  import { useReliableKernelClientFeedStore } from '/src/stores/useReliableKernelClientFeedStore.ts';
  const pinia = createPinia();
  setActivePinia(pinia);
  const feed = useReliableKernelClientFeedStore();
  window.feed = feed;
  window.requests = [];
  feed.requestDetail = (kind, recordId) => window.requests.push({ kind, recordId });
  const toolName = new URLSearchParams(window.location.search).get('command') || 'edit';
  const args = toolName === 'edit'
    ? { path: 'src/example.ts', mode: 'hunk', hunks: [{ oldContent: 'before', newContent: 'after' }],
      insert: { line: 1, content: 'unused-fixture-branch' } }
    : { mode: 'execute', command: 'npm test', explanation: '运行命令并收集结果' };
  const part = { id: 'provider-call', functionCall: { name: toolName, args } };
  feed.projections.activeConversationWindow = { conversationId: 'conversation' };
  feed.records = {
    Turn: { turn: { id: 'turn', conversation_id: 'conversation', status: 'active' } },
    Message: { message: { id: 'message', conversation_id: 'conversation', role: 'model', message_seq: '1',
      revision_id: 'revision', created_at: '2026-10-09T10:00:00.000Z' } },
    MessageTurnLink: { link: { id: 'link', message_id: 'message', turn_id: 'turn', role: 'model' } },
    ToolCall: { call: { id: 'call', turn_id: 'turn', call_seq: '1', tool_name: toolName, status: 'terminal' } },
    ToolCallSourceLink: { source: { id: 'source', tool_call_id: 'call', model_request_id: 'request',
      message_id: 'message', provider_call_id: 'provider-call', provider_ordinal: 0 } },
    ToolCallPolicySnapshot: { policy: { id: 'policy', tool_call_id: 'call', display_auto_expand: 0, display_auto_open_diff: 0 } },
    ToolOutcome: { outcome: { id: 'outcome', tool_call_id: 'call', status: 'succeeded' } }
  };
  const detail = value => ({ status: 'ready', text: JSON.stringify(value) });
  feed.details['message-content:revision'] = detail({ role: 'model', parts: [part] });
  feed.details['tool-arguments-content:call'] = detail(args);
  feed.details['tool-result-content:call'] = detail({ detail: toolName === 'edit'
    ? { mode: 'hunk', ignoredBranches: ['insert'], warning: '已选择 mode=hunk；未执行分支：insert。' }
    : { stdout: 'command output ready', exitCode: 0 } });
  createApp(Card, { part, messageId: 'message', toolOrdinal: 0 }).use(pinia).mount('#app');
</script></body></html>`;

test('file preview loads arriving members, starts expanded and respects the user collapsing it', async () => {
  const { createServer } = await import('vite');
  const server = await createServer({
    configFile: path.resolve('vite.config.ts'),
    server: { host: '127.0.0.1', port: 0, strictPort: false, hmr: false },
    plugins: [{
      name: 'file-preview-browser-fixture',
      configureServer(vite) {
        vite.middlewares.use('/file-preview-fixture', async (_request, response) => {
          response.setHeader('Content-Type', 'text/html');
          response.end(await vite.transformIndexHtml('/file-preview-fixture', fixtureHtml));
        });
      }
    }]
  });
  let browser;
  const errors = [];
  try {
    await server.listen();
    browser = await chromium.launch({ headless: true,
      ...(process.env.LIMCODE_TEST_BROWSER_PATH ? { executablePath: process.env.LIMCODE_TEST_BROWSER_PATH } : {}) });
    const page = await browser.newPage({ viewport: { width: 1000, height: 800 } });
    page.setDefaultTimeout(10000);
    page.on('pageerror', error => errors.push(error.message));
    await page.goto(`http://127.0.0.1:${server.httpServer.address().port}/file-preview-fixture`);
    const toggle = page.locator('.tool-call-card > .lc-collapsible-header .lc-collapsible-summary');
    await toggle.waitFor();
    assert.equal(await toggle.getAttribute('aria-expanded'), 'true');
    assert.equal(await page.getByText('原始参数', { exact: true }).count(), 0);
    assert.equal(await page.getByText('修改参数', { exact: true }).count(), 0);

    await page.evaluate(() => {
      window.feed.records.FileChangeSet = { set: { id: 'set', tool_call_id: 'call', status: 'applied' } };
      window.feed.records.FileChangeSetMember = { member: { id: 'member', change_set_id: 'set', member_seq: '1',
        operation: 'replace_file', target_path: 'src/example.ts' } };
    });
    await page.waitForFunction(() => window.requests.some(request => request.kind === 'file-change-diff' && request.recordId === 'member'));
    await page.getByRole('button', { name: '使用执行记录中的修改前后内容查看差异，不依赖工作区当前文件' }).waitFor();
    await page.locator('.tool-diff-file-path').waitFor();
    const setDiff = text => page.evaluate(text => {
      window.feed.details['file-change-diff:member'] = { status: 'ready', text: JSON.stringify({
        path: 'src/example.ts', diff: { text, added: 2, removed: 2 }
      }) };
    }, text);
    await setDiff('@@ -10,1 +10,1 @@\n-before\n+after\n@@ -42,1 +42,1 @@\n-old tail\n+new tail');
    await page.locator('.tool-diff-line-code').filter({ hasText: '+after' }).waitFor();
    assert.ok((await page.locator('.tool-diff-line-number').allTextContents()).includes('42'));
    assert.equal(await page.evaluate(() => window.posted.some(message => message.type === 'tool.diff.open')), false);

    const detailsToggle = page.locator('.tool-call-details > .lc-collapsible-header .lc-collapsible-summary');
    assert.equal(await detailsToggle.getAttribute('aria-expanded'), 'false');
    await detailsToggle.click();
    await page.getByText('原始参数', { exact: true }).waitFor();
    assert.match(await page.locator('.tool-call-details').innerText(), /unused-fixture-branch/);
    await detailsToggle.click();
    await page.getByText('原始参数', { exact: true }).waitFor({ state: 'hidden' });

    await toggle.click();
    await page.locator('.tool-diff-view').waitFor({ state: 'detached' });
    await setDiff('@@ -10,1 +10,1 @@\n-before\n+updated while collapsed');
    assert.equal(await toggle.getAttribute('aria-expanded'), 'false');
    assert.equal(await page.locator('.tool-diff-view').count(), 0);
    await toggle.click();
    await page.locator('.tool-diff-line-code').filter({ hasText: 'updated while collapsed' }).waitFor();
    assert.equal(await detailsToggle.getAttribute('aria-expanded'), 'false');

    for (const command of ['bash', 'shell']) {
      await page.goto(`http://127.0.0.1:${server.httpServer.address().port}/file-preview-fixture?command=${command}`);
      await toggle.waitFor();
      assert.equal(await toggle.getAttribute('aria-expanded'), 'false');
      assert.match(await toggle.innerText(), /运行命令并收集结果/);
      assert.equal(await page.getByText('command output ready', { exact: true }).count(), 0);
      await page.evaluate(() => {
        window.feed.records.FileChangeSet = { set: { id: 'set', tool_call_id: 'call', status: 'applied' } };
        window.feed.records.FileChangeSetMember = { member: { id: 'member', change_set_id: 'set', member_seq: '1',
          operation: 'replace_file', target_path: 'src/example.ts' } };
      });
      await setDiff('@@ -10,1 +10,1 @@\n-before\n+command generated change');
      assert.equal(await toggle.getAttribute('aria-expanded'), 'false');
      assert.match(await toggle.innerText(), /运行命令并收集结果/);
      assert.equal(await page.locator('.tool-diff-view').count(), 0);
      assert.equal(await page.evaluate(() => window.requests.some(request => request.kind === 'file-change-diff')), false);
      await toggle.click();
      await page.locator('.tool-diff-line-code').filter({ hasText: 'command generated change' }).waitFor();
      assert.match(await page.locator('.tool-call-card').innerText(), /command output ready/);
      assert.match(await toggle.innerText(), /运行命令并收集结果/);
      await toggle.click();
      await page.locator('.tool-diff-view').waitFor({ state: 'detached' });
    }
    assert.deepEqual(errors, []);
    await page.close();
  } finally {
    await browser?.close();
    await server.close();
  }
});
