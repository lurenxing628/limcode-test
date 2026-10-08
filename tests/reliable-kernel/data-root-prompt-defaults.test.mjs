import assert from 'node:assert/strict';
import test from 'node:test';
import { createWebviewSsrServer } from './webview-ssr-server.mjs';

// The settings page's confirmation panel (useDataRootPromptStore): an option the command ticks by
// default (`checked`, 清理备份's complete copies) starts ticked, every other one (the copies with
// content deleted or replaced elsewhere, any option without `checked`) starts unticked; the answer
// carries exactly what is ticked when it is given.
test('确认面板的勾选框：命令默认勾选（checked）的项一打开就勾上，其它的不勾；答复只带答复时勾着的项；下一个面板重新按它自己的默认', async () => {
  const pinia = await import('pinia');
  const previousPinia = pinia.getActivePinia();
  const previousWindow = globalThis.window;
  const listeners = [];
  const posted = [];
  globalThis.window = {
    addEventListener(type, listener) { if (type === 'message') listeners.push(listener); },
    removeEventListener() {}, setTimeout, clearTimeout,
    acquireVsCodeApi() { return { postMessage(message) { posted.push(message); }, getState() { return {}; }, setState() {} }; }
  };
  let server;
  try {
    server = await createWebviewSsrServer();
    const { useDataRootPromptStore } = await server.ssrLoadModule('/src/stores/useDataRootPromptStore.ts');
    pinia.setActivePinia(pinia.createPinia());
    const store = useDataRootPromptStore();
    store.initialize();
    const deliver = (payload) => { for (const listener of listeners) listener({ data: { id: `m-${payload.flowId}`, type: 'dataRoot.prompt', payload } }); };

    deliver({
      flowId: 'flow-1', title: '清理备份：勾选要删除的备份',
      sections: [
        { title: '合并前备份（2 项）', lines: [], options: [{ key: 'complete', label: 'a', checked: true }, { key: 'unmarked', label: 'b' }] },
        { title: '含你后来删除或替换的内容（1 项）', lines: [], options: [{ key: 'replaced', label: 'c', checked: false }] }
      ],
      options: [{ key: 'flat', label: 'd', checked: true }],
      actions: [{ key: 'cancel', label: '取消' }, { key: 'next', label: '下一步' }]
    });
    assert.equal(store.prompt?.flowId, 'flow-1');
    assert.deepEqual([...store.include].sort(), ['complete', 'flat'], '只有 checked 的项一打开就勾上');

    store.toggle('complete', false);
    store.toggle('replaced', true);
    store.answer('next');
    const answer = posted.filter((message) => message.type === 'dataRoot.action').at(-1);
    assert.deepEqual(answer?.payload, { action: 'answer', flowId: 'flow-1', choice: 'next', include: ['flat', 'replaced'] });

    deliver({ flowId: 'flow-2', title: '永久删除所选备份？', sections: [{ lines: ['x'] }], actions: [{ key: 'delete', label: '永久删除' }] });
    assert.deepEqual(store.include, [], '没有勾选框的面板从空开始');
    deliver({
      flowId: 'flow-3', title: '清理备份：勾选要删除的备份',
      sections: [{ title: '已合并来源（1 项）', lines: [], options: [{ key: 'unticked', label: 'e' }] }], actions: []
    });
    assert.deepEqual(store.include, [], '没有 checked 的项不勾');
    const superseded = posted.filter((message) => message.type === 'dataRoot.action').at(-1);
    assert.deepEqual(superseded?.payload, { action: 'answer', flowId: 'flow-2', choice: 'cancel', include: [] }, '新的面板取代没回答的旧面板');
  } finally {
    await server?.close();
    globalThis.window = previousWindow;
    if (previousPinia) pinia.setActivePinia(previousPinia);
  }
});

// 盲审 #2: the hint beside 清理备份… in the settings page (其他 → 数据目录) says what the cleanup does
// (AGENTS.md, 备份清理): current history proves ordinary backup coverage; completed, unchanged
// sources have their own deletion rule; retained data and new reset backups remain protected.
// The first case above also keeps the prompt's checked-by-default behavior covered.
test('设置页“清理备份…”旁的说明与实际行为一致：当前历史覆盖、已合并来源条件、残留保留与替换消息单列不勾选', async () => {
  const { createSSRApp } = await import('vue');
  const { renderToString } = await import('@vue/server-renderer');
  const pinia = await import('pinia');
  const previousPinia = pinia.getActivePinia();
  const previousWindow = globalThis.window;
  const previousDocument = globalThis.document;
  globalThis.window = {
    addEventListener() {}, removeEventListener() {}, setTimeout, clearTimeout, innerWidth: 1280, innerHeight: 800,
    acquireVsCodeApi() { return { postMessage() {}, getState() { return {}; }, setState() {} }; }
  };
  let server;
  try {
    server = await createWebviewSsrServer();
    const { default: tab } = await server.ssrLoadModule('/src/components/settings/global/OtherSettingsTab.vue');
    const isolated = pinia.createPinia();
    pinia.setActivePinia(isolated);
    // The tab's hover tooltips measure the viewport while they are set up (only now: Vite itself
    // must not see a document while it loads).
    globalThis.document = { documentElement: { clientWidth: 1280, clientHeight: 800 } };
    const html = await renderToString(createSSRApp(tab).use(isolated));
    const hint = html.match(/<span class="global-settings-field-hint">(迁移时先检查新目录[^<]*)<\/span>/)?.[1];
    assert.ok(hint, '找到数据目录一栏的说明');
    const cleanup = hint.slice(hint.indexOf('清理备份'));
    for (const phrase of [
      '清理备份先检查再确认',
      '普通备份只由当前历史证明记录、正文和可见消息完整覆盖',
      '已合并来源须完整合并且未改变，待合并、部分合并和残留数据保留',
      '仅在备份里仍可见的已删除、编辑或替换消息单独列出，默认不勾选',
      '新的归档重置备份不会自动删除'
    ]) assert.ok(cleanup.includes(phrase), `说明里没有“${phrase}”：${cleanup}`);
    assert.doesNotMatch(cleanup, /当前库或同一数据目录的某个历史库|核验通过的外来历史库/, '不恢复跨库覆盖或外来来源一概可删除的旧口径');
  } finally {
    await server?.close();
    globalThis.window = previousWindow;
    if (previousDocument === undefined) delete globalThis.document;
    else globalThis.document = previousDocument;
    if (previousPinia) pinia.setActivePinia(previousPinia);
  }
});
