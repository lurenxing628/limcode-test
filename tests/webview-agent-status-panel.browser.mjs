import assert from 'node:assert/strict';
import path from 'node:path';
import test from 'node:test';
import { chromium } from 'playwright';

// Mount the production child Agent panel with the global theme stylesheet, so the global button
// hover rule and the real grid/flex layout apply. Only the feed, Agent store and bridge are stubbed.
const fixture = `
  import { reactive, ref } from 'vue';
  const args = (value) => ({ status: 'ready', text: JSON.stringify(value), totalBytes: 1 });
  const boilerplate = '用户已授权获批修复计划由子 Agent 实施，父 Agent 只验收。';
  const feed = reactive({
    records: {
      Turn: {
        parent: { id: 'parent-turn', conversation_id: 'parent', status: 'active' },
        closed: { id: 'closed-turn', conversation_id: 'child-closed', status: 'terminated' }
      },
      AgentConversationLink: {
        parent: { id: 'parent-link', conversation_id: 'parent', agent_id: 'main', role: 'default' },
        active: { id: 'active-link', conversation_id: 'child-active', agent_id: 'worker', role: 'default' },
        plan: { id: 'plan-link', conversation_id: 'child-plan', agent_id: 'worker', role: 'default' },
        closed: { id: 'closed-link', conversation_id: 'child-closed', agent_id: 'explore', role: 'default' }
      },
      ChildExecution: {
        active: { id: 'active', child_conversation_id: 'child-active', status: 'active', created_at: '2026-09-24T19:30:00.000Z', updated_at: '2026-09-24T19:40:00.000Z' },
        plan: { id: 'plan', child_conversation_id: 'child-plan', status: 'idle', created_at: '2026-09-24T19:20:00.000Z', updated_at: '2026-09-24T19:35:00.000Z' },
        closed: { id: 'closed', child_conversation_id: 'child-closed', status: 'closed', created_at: '2026-09-24T19:10:00.000Z', updated_at: '2026-09-24T19:30:00.000Z' }
      },
      ChildExecutionParentLink: {
        active: { id: 'active-parent', child_execution_id: 'active', parent_turn_id: 'parent-turn', source_tool_call_id: 'spawn-active' },
        plan: { id: 'plan-parent', child_execution_id: 'plan', parent_turn_id: 'parent-turn', source_tool_call_id: 'submit-plan' },
        closed: { id: 'closed-parent', child_execution_id: 'closed', parent_turn_id: 'parent-turn', source_tool_call_id: 'spawn-closed' }
      },
      ChildExecutionTurnLink: {
        closed: { id: 'closed-turn-link', child_execution_id: 'closed', turn_seq: 1, turn_id: 'closed-turn' }
      }
    },
    details: {
      'tool-arguments-content:spawn-active': args({ operation: 'spawn', agent: { type: 'worker' }, taskName: '修复转向归属', prompt: boilerplate + '修复 WebSocket 转向归属。' }),
      'tool-arguments-content:submit-plan': args({ plan: '# 计划\\n1. 修复', taskList: { mode: 'rewrite', items: [] } }),
      'tool-arguments-content:spawn-closed': args({ operation: 'spawn', agent: { type: 'explore' }, taskName: '核验未知结果持久凭据', prompt: boilerplate + '只读核验。' })
    },
    requestDetail() {}
  });
  export const useReliableConversation = () => ({ feed, conversationId: ref('parent') });
  export const useAgentStore = () => ({ agents: [
    { id: 'main', name: 'LimCode' }, { id: 'worker', name: 'Worker Agent' }, { id: 'explore', name: 'Explore Agent' }
  ] });
  export const useChat = () => ({ interruptPhase: ref(null) });
  export const bridge = { on: () => () => {}, request: () => 'request' };
`;

const stubbedImports = [
  '@webview/composables/useReliableConversation',
  '@webview/stores/useAgentStore',
  '@webview/composables/useChat',
  '@webview/transport'
];

test('child Agent list titles rows by task and keeps them readable in narrow and wide panels', async () => {
  const { createServer: createViteServer } = await import('vite');
  const server = await createViteServer({
    configFile: path.resolve('vite.config.ts'),
    server: { host: '127.0.0.1', port: 0, strictPort: false, hmr: false },
    plugins: [{
      name: 'agent-status-panel-browser-fixture', enforce: 'pre',
      resolveId(id) { if (id === 'virtual:agent-panel-fixture') return '\0' + id; },
      load(id) { if (id === '\0virtual:agent-panel-fixture') return fixture; },
      transform(code, id) {
        if (!id.endsWith('/ReliableAgentStatusPanel.vue')) return;
        for (const specifier of stubbedImports) code = code.replaceAll(`from '${specifier}'`, "from 'virtual:agent-panel-fixture'");
        return code;
      },
      configureServer(vite) {
        vite.middlewares.use('/agent-status-panel-fixture', async (_request, response) => {
          response.setHeader('Content-Type', 'text/html');
          response.end(await vite.transformIndexHtml('/agent-status-panel-fixture', `<link rel="icon" href="data:,">
            <style>:root { --vscode-button-hoverBackground: rgb(2, 110, 193); --vscode-editor-background: rgb(31, 31, 31); }</style>
            <div id="panel-anchor" style="position:fixed;right:40px;bottom:12px"></div><script type="module">
            import '/src/theme/tokens.css';
            import '/src/theme/base.css';
            import { createApp } from 'vue';
            import Panel from '/src/components/input/ReliableAgentStatusPanel.vue';
            createApp(Panel).mount('#panel-anchor');
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
    for (const width of [420, 1000]) {
      const page = await browser.newPage({ viewport: { width, height: 800 } });
      page.setDefaultTimeout(10000);
      page.on('pageerror', error => errors.push(error.message));
      await page.goto(`http://127.0.0.1:${server.httpServer.address().port}/agent-status-panel-fixture`);
      await page.locator('.agent-run-trigger').click();
      await page.locator('.agent-run-item').first().waitFor();

      const rows = await page.evaluate(() => [...document.querySelectorAll('.agent-run-item')].map((item) => {
        const title = item.querySelector('.agent-run-target');
        const stop = item.querySelector('.agent-run-item-stop');
        return {
          title: title.textContent,
          agent: item.querySelector('.agent-run-agent').textContent,
          preview: item.querySelector('.agent-run-preview').textContent,
          titleFits: title.clientWidth + 1 >= title.scrollWidth,
          titleContentRight: title.getBoundingClientRect().right - parseFloat(getComputedStyle(title).paddingRight),
          stopLeft: stop?.getBoundingClientRect().left
        };
      }));
      assert.deepEqual(rows.map(row => row.title), ['修复转向归属', '执行已批准的 Plan', '核验未知结果持久凭据'], `${width}px`);
      assert.deepEqual(rows.map(row => row.agent), ['Worker Agent', 'Worker Agent', 'Explore Agent'], `${width}px`);
      assert.ok(rows[0].preview.startsWith('用户已授权获批修复计划'), `${width}px`);
      assert.ok(rows.every(row => row.titleFits), `${width}px 标题应完整可见：${JSON.stringify(rows)}`);
      assert.ok(rows.every(row => row.stopLeft === undefined || row.titleContentRight <= row.stopLeft),
        `${width}px 标题不能压住终止按钮：${JSON.stringify(rows)}`);

      const layout = await page.evaluate(() => {
        const rect = selector => document.querySelector(selector).getBoundingClientRect();
        return { panel: rect('.agent-run-panel'), list: rect('.agent-run-list'), detail: rect('.agent-run-detail') };
      });
      assert.ok(layout.panel.left >= 0, `${width}px 面板不能越出视口`);
      if (width < 620) assert.ok(layout.list.bottom <= layout.detail.top + 1, '窄面板中列表应位于详情上方');
      else assert.ok(layout.list.right <= layout.detail.left + 1, '宽面板中列表应位于详情左侧');

      const hoverFill = async (locator) => {
        await locator.hover();
        return locator.evaluate(element => getComputedStyle(element).backgroundColor);
      };
      assert.equal(await hoverFill(page.locator('.agent-run-item-select').nth(1)), 'rgba(0, 0, 0, 0)', '列表项悬停不能套用全局蓝色按钮底色');
      await page.locator('.agent-run-item-select').first().click();
      assert.notEqual(await hoverFill(page.locator('.agent-run-action-button')), 'rgb(2, 110, 193)', '终止按钮悬停不能套用全局蓝色按钮底色');
      assert.equal(await page.locator('.agent-run-detail-name').textContent(), '修复转向归属');

      await page.locator('.agent-run-item-select').nth(2).click();
      assert.equal(await page.locator('.agent-run-detail-name').textContent(), '核验未知结果持久凭据');
      await page.locator('.agent-run-param-grid dd', { hasText: '已结束 (terminated)' }).waitFor();
      await page.close();
    }
    assert.deepEqual(errors, []);
  } finally {
    await browser?.close();
    await server.close();
  }
});
