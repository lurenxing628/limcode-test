import assert from 'node:assert/strict';
import test from 'node:test';
import { createWebviewSsrServer } from './webview-ssr-server.mjs';

const estimate = { sourceTokens: 123_400, summaryCount: 1, contextWindowTokens: 200_000, inputCapacityTokens: 184_000 };
const loaded = (outcome, withEstimate = true) => ({
  status: 'loaded',
  result: { conversationId: 'conversation', rootId: 'root', ...(withEstimate ? { estimate } : {}), outcome }
});

async function renderDialog(server, props) {
  const { default: dialog } = await server.ssrLoadModule('/src/components/input/SummaryRebuildConfirm.vue');
  const { createSSRApp } = await import('vue');
  const { renderToString } = await import('@vue/server-renderer');
  const context = {};
  await renderToString(createSSRApp(dialog, { open: true, targetCurrent: true, ...props }), context);
  const html = Object.values(context.teleports ?? {}).join('');
  const confirm = html.match(/<button[^>]*data-testid="compression-rebuild-confirm-confirm"[^>]*>/)?.[0] ?? '';
  return { html, text: html.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' '), confirmDisabled: /\sdisabled/.test(confirm), confirm };
}

test('重建确认框：估算中、可重建、超限和估算失败四种状态', async () => {
  const server = await createWebviewSsrServer();
  try {
    const loading = await renderDialog(server, { preview: { status: 'loading' } });
    assert.ok(loading.confirm, 'the confirm button renders');
    assert.match(loading.text, /把当前上下文里的摘要全部展开成原始对话和工具记录/);
    assert.match(loading.text, /最多 32 段/);
    assert.match(loading.text, /输入 token 大约等于原始记录的总量/);
    assert.match(loading.text, /正在估算原始记录的大小/);
    assert.equal(loading.confirmDisabled, true);

    const ready = await renderDialog(server, { preview: loaded({
      kind: 'ready', methodKind: 'segmented_summary', providerRequests: 6, summaryRequests: 5, mergeRequests: 1, attachmentRequests: 0
    }) });
    assert.match(ready.text, /原始记录 约 123.4k tokens（本地估算）/);
    assert.match(ready.text, /压缩模型窗口 200k tokens/);
    assert.match(ready.text, /预计请求 约 6 次（分 5 段总结，合并 1 次）/);
    assert.equal(ready.confirmDisabled, false);

    const over = await renderDialog(server, { preview: loaded({ kind: 'blocked', reason: 'leaf_budget_exceeded', leafRequestLimit: 32 }) });
    assert.match(over.text, /无法重建：原始记录太长，要分成超过 32 段才能总结/);
    assert.match(over.text, /原始记录 约 123.4k tokens/);
    assert.equal(over.confirmDisabled, true);

    const failed = await renderDialog(server, { preview: loaded({ kind: 'error', message: '来源缺失' }, false) });
    assert.match(failed.text, /暂时无法估算：来源缺失。仍可重建/);
    assert.equal(failed.confirmDisabled, false);

    const moved = await renderDialog(server, { targetCurrent: false, preview: loaded({
      kind: 'ready', methodKind: 'llm_summary', providerRequests: 1, summaryRequests: 1, mergeRequests: 0, attachmentRequests: 0
    }) });
    assert.match(moved.text, /当前上下文或执行状态已变化/);
    assert.equal(moved.confirmDisabled, true);
  } finally {
    await server.close();
  }
});

test('重建按钮的悬浮说明讲清楚它做什么', async () => {
  const server = await createWebviewSsrServer();
  try {
    const { summaryRebuildTooltipRows } = await server.ssrLoadModule('/src/components/input/summaryRebuildPreview.ts');
    const text = summaryRebuildTooltipRows().map((row) => `${row.label}：${row.value}`).join('\n');
    assert.match(text, /展开成原始对话和工具记录，再重新总结/);
    assert.match(text, /不会删除/);
    assert.match(text, /先估算/);
  } finally {
    await server.close();
  }
});
