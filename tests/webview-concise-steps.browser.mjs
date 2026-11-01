import assert from 'node:assert/strict';
import test from 'node:test';
import { chromium } from 'playwright';
import { createBrowserFixtureServer } from './reliable-kernel/browser-fixture-server.mjs';

const fixtureHtml = `<!doctype html><html><head><link rel="icon" href="data:,"></head><body>
<div id="app" style="width:720px"></div>
<div id="activity" style="width:720px"></div>
<script>
  window.acquireVsCodeApi = () => ({ postMessage() {}, getState() {}, setState() {} });
</script>
<script type="module">
  import '/src/theme/tokens.css';
  import '/src/theme/base.css';
  import '/src/theme/motion/collapse.css';
  import '/src/theme/motion/content.css';
  import { createApp } from 'vue';
  import { createPinia, setActivePinia } from 'pinia';
  import MessageItem from '/src/components/conversation/MessageItem.vue';
  import TimelineActivityRow from '/src/components/conversation/TimelineActivityRow.vue';
  import { useReliableKernelClientFeedStore } from '/src/stores/useReliableKernelClientFeedStore.ts';
  import { useGlobalSettingsStore } from '/src/stores/useGlobalSettingsStore.ts';
  const query = new URLSearchParams(window.location.search);
  const pinia = createPinia();
  setActivePinia(pinia);
  useGlobalSettingsStore().appearance.conciseMode = query.has('concise');
  const feed = useReliableKernelClientFeedStore();
  feed.requestDetail = () => {};
  const calls = [
    { id: 'provider-write', functionCall: { name: 'write', args: { path: 'src/helper.txt', content: 'x' } } },
    { id: 'provider-read', functionCall: { name: 'read', args: { path: 'docs/main.md' } } }
  ];
  if (query.has('cmd')) calls.push({ id: 'provider-cmd', functionCall: { name: 'bash', args: { command: query.get('cmd') } } });
  if (query.has('many')) calls.push(
    { id: 'provider-read-2', functionCall: { name: 'read', args: { path: 'docs/a.md' } } },
    { id: 'provider-read-3', functionCall: { name: 'read', args: { path: 'docs/main.md' } } },
    { id: 'provider-read-4', functionCall: { name: 'read', args: { path: 'docs/b.md' } } },
    { id: 'provider-bash', functionCall: { name: 'bash', args: { command: 'npm test' } } },
    { id: 'provider-shell', functionCall: { name: 'shell', args: { command: "$f = 'e:\维护\a.md'; Test-Path $f" } } },
    { id: 'provider-mcp', functionCall: { name: 'mcp_lookup', args: {} } },
    { id: 'provider-mcp-2', functionCall: { name: 'mcp_lookup', args: {} } }
  );
  const parts = query.has('waiting') ? []
    : query.has('thinking') ? [{ text: '先写再读', thought: true }]
    : [{ text: '先写再读', thought: true, thoughtDurationMs: 1200 }, ...calls];
  if (query.has('text')) parts.push({ text: '全部完成。' });
  const streaming = query.has('waiting') || query.has('thinking');
  const session = { sessionId: 'concise-session', hostBootId: 'concise-host' };
  feed.observe({ type: 'reliable-kernel.snapshot', ...session, messageSeq: '1', snapshotCommitSeq: '1',
    projections: { activeConversationWindow: {
      conversationId: 'conversation',
      turns: [{ id: 'turn', conversation_id: 'conversation', status: 'active' }],
      messages: [{ id: 'message', conversation_id: 'conversation', role: 'model', message_seq: '1',
        revision_id: 'revision', created_at: '2026-10-25T10:00:00.000Z' }],
      messageTurnLinks: [{ id: 'link', message_id: 'message', turn_id: 'turn', role: 'model' }],
      toolCalls: calls.map((part, index) => ({ id: 'call-' + index, turn_id: 'turn', call_seq: String(index + 1),
        tool_name: part.functionCall.name, status: query.has('pending') && index === 1 ? 'pending' : 'terminal' })),
      toolCallSourceLinks: calls.map((part, index) => ({ id: 'source-' + index, tool_call_id: 'call-' + index,
        model_request_id: 'request', message_id: 'message', provider_call_id: part.id, provider_ordinal: index })),
      toolOutcomes: calls.flatMap((part, index) => query.has('pending') && index === 1 ? []
        : [{ id: 'outcome-' + index, tool_call_id: 'call-' + index, status: 'succeeded' }]),
      // 第二个调用挂着一条待处理的执行审批。
      interactionRequests: query.has('pending') ? [{ id: 'approval', request_kind: 'exec_approval', status: 'pending',
        created_at: '2026-10-25T10:00:01.000Z', updated_at: '2026-10-25T10:00:01.000Z' }] : [],
      interactionToolCallLinks: query.has('pending') ? [{ id: 'approval-link', request_id: 'approval', tool_call_id: 'call-1' }] : []
    } }
  });
  const message = { id: 'message', conversationId: 'conversation', role: 'model', model: 'fast-model',
    status: streaming ? 'streaming' : 'final', content: { role: 'model', parts }, createdAt: 1, requestStartedAt: 1, completedAt: 2000 };
  createApp(MessageItem, { message, floorNumber: 64 }).use(pinia).mount('#app');
  const settings = useGlobalSettingsStore();
  createApp(TimelineActivityRow, { activityKind: 'preparing', label: settings.appearance.streamingTextWaiting,
    modelLabel: 'fast-model', concise: settings.appearance.conciseMode }).use(pinia).mount('#activity');
</script></body></html>`;

test('concise mode folds a tool-only round into one step summary row', async () => {
  const server = await createBrowserFixtureServer({
    dependencies: ['vue', 'pinia', '@tabler/icons-vue', 'markdown-it', 'markdown-it-texmath', 'katex'],
    plugins: [{
      name: 'concise-steps-browser-fixture',
      configureServer(vite) {
        vite.middlewares.use('/concise-steps-fixture', async (_request, response) => {
          response.setHeader('Content-Type', 'text/html');
          response.end(await vite.transformIndexHtml('/concise-steps-fixture', fixtureHtml));
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
    const open = search => page.goto(`http://127.0.0.1:${server.httpServer.address().port}/concise-steps-fixture${search}`, { waitUntil: 'domcontentloaded' });
    const summary = page.locator('.rich-step-group > .lc-collapsible-header .lc-collapsible-summary');

    // 普通模式：头部、思考、两张工具卡和底栏照常显示。
    await open('');
    await page.locator('.tool-call-card').nth(1).waitFor();
    assert.equal(await page.locator('.floor-header').count(), 1);
    assert.equal(await page.locator('.message-footer').count(), 1);
    assert.equal(await page.locator('.rich-step-group').count(), 0);

    // 简洁模式：整条消息只剩一行步骤摘要，点开才渲染思考和工具卡。
    await open('?concise');
    await summary.waitFor();
    assert.equal(await page.locator('.rich-step-group-label').innerText(), '修改 helper.txt · 读取 main.md');
    assert.equal(await page.locator('.rich-step-group-label.lc-shimmer-text').count(), 0);
    assert.equal(await summary.getAttribute('aria-expanded'), 'false');
    assert.equal(await page.locator('.floor-header').count(), 0);
    assert.equal(await page.locator('.message-footer').count(), 0);
    assert.equal(await page.locator('.tool-call-card').count(), 0);
    await summary.click();
    await page.locator('.tool-call-card').nth(1).waitFor();
    assert.equal(await page.locator('.rich-step-group .lc-collapsible-block').filter({ hasText: '已思考' }).count(), 1);
    await summary.click();
    await page.locator('.tool-call-card').first().waitFor({ state: 'detached' });

    // 按动作归类计数：同一文件只算一次，单个目标直接写出，认不出的工具写工具名和次数。
    await open('?concise&many');
    await summary.waitFor();
    assert.equal(await page.locator('.rich-step-group-label').innerText(),
      '修改 helper.txt · 读取 3 个文件 · 运行 2 条命令 · 调用 mcp_lookup ×2');

    // 单条命令只写程序名；以变量开头的 PowerShell 看不出在做什么，只写条数。
    await open('?concise&cmd=' + encodeURIComponent('npm run build -- --watch'));
    await summary.waitFor();
    assert.equal(await page.locator('.rich-step-group-label').innerText(), '修改 helper.txt · 读取 main.md · 运行 npm');
    await open('?concise&cmd=' + encodeURIComponent("$f = 'e:/维护/a.md'; Test-Path $f"));
    await summary.waitFor();
    assert.equal(await page.locator('.rich-step-group-label').innerText(), '修改 helper.txt · 读取 main.md · 运行 1 条命令');

    // 有正文的消息也不显示头部，模型名挪到底栏；步骤照样折叠。
    await open('?concise&text');
    await summary.waitFor();
    assert.equal(await page.locator('.floor-header').count(), 0);
    assert.match(await page.locator('.message-footer').innerText(), /fast-model/);
    await page.getByText('全部完成。').waitFor();

    // 流式中：等待首个内容块和思考中都显示同一行步骤卡，不出现头部和独立的编写中尾行。
    await open('?concise&waiting');
    await page.locator('.rich-step-group').waitFor();
    assert.equal(await page.locator('.floor-header').count(), 0);
    assert.match(await page.locator('.rich-step-group').innerText(), /少女等待中/);
    // 每轮开始前列表里那行等待提示，换成这条消息时高度和文字都不变。
    const heights = await page.evaluate(() => [document.querySelector('.message-floor').getBoundingClientRect().height,
      document.querySelector('.timeline-activity-row').getBoundingClientRect().height]);
    assert.equal(heights[0], heights[1]);
    assert.equal(await page.locator('.timeline-activity-row').innerText(), await page.locator('.rich-step-group').innerText());
    assert.equal(await page.locator('.timeline-activity-row .activity-header').count(), 0);
    assert.equal(await page.locator('.activity-concise-label.lc-shimmer-text').count(), 1);
    // 这行插入时淡入，不硬跳。
    assert.match(await page.locator('.timeline-activity-row').evaluate(node => getComputedStyle(node).animationName), /lc-concise-row-enter/);
    assert.equal(await page.locator('.rich-step-group-label.lc-shimmer-text').count(), 1);
    await open('?concise&thinking');
    await summary.waitFor();
    assert.match(await summary.innerText(), /少女思考中/);
    assert.equal(await page.locator('.floor-header').count(), 0);
    assert.equal(await page.locator('.rich-streaming-tail-row').count(), 0);

    // 等待审批的调用不能藏起来：摘要自动展开。
    await open('?concise&pending');
    await summary.waitFor();
    assert.equal(await summary.getAttribute('aria-expanded'), 'true');
    assert.match(await summary.innerText(), /进行中/);
    // 进行中的摘要文字带扫光动画。
    assert.equal(await page.locator('.rich-step-group-label.lc-shimmer-text').count(), 1);
    await page.locator('.tool-call-card').nth(1).waitFor();
    assert.deepEqual(errors, []);
    await page.close();
  } finally {
    await browser?.close();
    await server.close();
  }
});
