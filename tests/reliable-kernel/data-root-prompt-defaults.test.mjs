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
      sections: [{ title: '外来历史库（1 项）', lines: [], options: [{ key: 'unticked', label: 'e' }] }], actions: []
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
// (AGENTS.md, 备份清理): verified foreign history is deletable too, the coverage it proves, which copies
// are ticked by default and which are listed apart; copied directories themselves are never deleted.
test('设置页“清理备份…”旁的说明与实际行为一致：核验通过的外来历史库也可以删除，写明覆盖口径、默认勾选与单列的一组', async () => {
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
      '清理备份只删除能证明内容已完整在本地库里的副本',
      '升级前、合并前与合并来源的收尾前备份，以及核验通过的外来历史库（“归档并重置”的归档、以前的数据目录里的归档和拷来目录里的库）',
      '每个对话、消息版本和工具调用、输出、回答等记录都要还在当前库或同一数据目录的某个历史库里，正文文件也在，副本里显示的每条消息在那里也显示同一个版本',
      '含有别处没有的对话或记录的一律保留',
      '内容完整的默认勾选；有消息在那里已被你删除、编辑或重试替换的单独列出，默认不勾选',
      '拷来目录本身和其中的设置、规则、技能不会被删除'
    ]) assert.ok(cleanup.includes(phrase), `说明里没有“${phrase}”：${cleanup}`);
    assert.doesNotMatch(cleanup, /只列出/, '归档和拷来目录里的库不再只列出');
  } finally {
    await server?.close();
    globalThis.window = previousWindow;
    if (previousDocument === undefined) delete globalThis.document;
    else globalThis.document = previousDocument;
    if (previousPinia) pinia.setActivePinia(previousPinia);
  }
});
