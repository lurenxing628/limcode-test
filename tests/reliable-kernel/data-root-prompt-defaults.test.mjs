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
