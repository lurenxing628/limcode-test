import { createWebviewSsrServer } from './webview-ssr-server.mjs';

export function createClock() {
  const timers = new Map();
  let now = 0, serial = 0;
  return {
    setTimeout(callback, delay = 0, ...args) { const id = ++serial; timers.set(id, { at: now + delay, callback: () => callback(...args) }); return id; },
    clearTimeout(id) { timers.delete(id); },
    async advance(ms) {
      const end = now + ms;
      for (;;) {
        const next = [...timers].filter(([, entry]) => entry.at <= end).sort((a, b) => a[1].at - b[1].at)[0];
        if (!next) break;
        now = next[1].at;
        timers.delete(next[0]);
        await next[1].callback();
        await Promise.resolve();
      }
      now = end;
    },
    dispose() { timers.clear(); }
  };
}

export async function createConfigurationUiGraph() {
  const previousWindow = globalThis.window;
  const sink = { current: undefined };
  globalThis.window = {
    innerWidth: 1024, innerHeight: 768,
    addEventListener() {}, removeEventListener() {},
    setTimeout(...args) { return sink.current?.clock.setTimeout(...args); },
    clearTimeout(id) { sink.current?.clock.clearTimeout(id); },
    acquireVsCodeApi() { return {
      postMessage(message) { sink.current?.messages.push(structuredClone(message)); },
      getState() { return sink.current?.persisted; },
      setState(value) { if (sink.current) sink.current.persisted = value; }
    }; }
  };
  let server;
  try {
    server = await createWebviewSsrServer();
    const vue = await import('vue'), pinia = await import('pinia');
    const modules = {};
    const client = await server.ssrLoadModule('/src/stores/useClientStateStore.ts');
    const profiles = await server.ssrLoadModule('/src/stores/useModelProfileStore.ts');
    const global = await server.ssrLoadModule('/src/stores/useGlobalSettingsStore.ts');
    const conversation = await server.ssrLoadModule('/src/stores/useConversationSettingsStore.ts');
    const prompts = await server.ssrLoadModule('/src/stores/useSystemPromptStore.ts');
    const tools = await server.ssrLoadModule('/src/stores/useToolPolicyStore.ts');
    const feed = await server.ssrLoadModule('/src/stores/useReliableKernelClientFeedStore.ts');
    for (const [name, file] of Object.entries({
      Prompt: '/src/components/settings/config/SystemPromptScopeEditor.vue',
      Model: '/src/components/settings/config/ModelProfileScopeEditor.vue',
      Thinking: '/src/components/input/SessionThinkingControl.vue',
      Composer: '/src/components/input/Composer.vue',
      Tools: '/src/components/settings/tools/ToolPolicyEditor.vue'
    })) modules[name] = (await server.ssrLoadModule(file)).default;
    const node = (type, text = '') => ({ type, text, props: {}, children: [] });
    const renderer = vue.createRenderer({
      createElement: node, createText: text => node('#text', text), createComment: text => node('#comment', text),
      setText(item, text) { item.text = text; }, setElementText(item, text) { item.text = text; item.children = []; },
      patchProp(item, key, _previous, next) { item.props[key] = next; },
      insert(item, parent, anchor) { item.parent = parent; const i = parent.children.indexOf(anchor); parent.children.splice(i < 0 ? parent.children.length : i, 0, item); },
      remove(item) { const parent = item.parent; if (parent) parent.children.splice(parent.children.indexOf(item), 1); },
      parentNode: item => item.parent, nextSibling: () => null
    });
    return {
      vue,
      session(t) {
        const isolated = pinia.createPinia(), previousPinia = pinia.getActivePinia();
        pinia.setActivePinia(isolated);
        const active = { clock: createClock(), messages: [], persisted: undefined };
        sink.current = active;
        // These actions use both browser timers and global timers. None outlive their Pinia session.
        t.mock.method(globalThis, 'setTimeout', active.clock.setTimeout);
        t.mock.method(globalThis, 'clearTimeout', active.clock.clearTimeout);
        const apps = [];
        const f = { ...active, vue, pinia: isolated,
          client: client.useClientStateStore(isolated), models: profiles.useModelProfileStore(isolated),
          global: global.useGlobalSettingsStore(isolated), conversation: conversation.useConversationSettingsStore(isolated),
          prompts: prompts.useSystemPromptStore(isolated), tools: tools.useToolPolicyStore(isolated), feed: feed.useReliableKernelClientFeedStore(isolated),
          mount(name, props = {}, render = false) {
            const component = render ? modules[name] : { ...modules[name], render() { return null; }, ssrRender: undefined };
            const app = renderer.createApp(component, props).use(isolated);
            app.provide(vue.ssrContextKey, { modules: new Set() });
            const root = node('root'), instance = app.mount(root);
            apps.push(app);
            return { view: instance.$.setupState, root };
          },
          messagesOf(type) { return active.messages.filter(message => message.type === type); },
          last(type) { return f.messagesOf(type).at(-1); }
        };
        t.after(() => {
          for (const app of apps) app.unmount();
          pinia.disposePinia(isolated);
          pinia.setActivePinia(previousPinia);
          active.clock.dispose();
          sink.current = undefined;
        });
        return f;
      },
      async close() {
        try { await server.close(); }
        finally { if (previousWindow === undefined) delete globalThis.window; else globalThis.window = previousWindow; }
      }
    };
  } catch (error) {
    try { await server?.close(); }
    finally { if (previousWindow === undefined) delete globalThis.window; else globalThis.window = previousWindow; }
    throw error;
  }
}
