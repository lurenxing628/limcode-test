import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { createRequire } from 'node:module';
import { compiled, extensionRoot } from './configuration-smoke-fixture.mjs';
const require = createRequire(import.meta.url);
const vue = require('vue'), pinia = require('pinia'), ts = require('typescript');
const { parse, compileScript } = require('@vue/compiler-sfc');
const sourceRoot = path.resolve('webview/src');
const componentFiles = {
  Prompt: path.join(sourceRoot, 'components/settings/config/SystemPromptScopeEditor.vue'),
  Model: path.join(sourceRoot, 'components/settings/config/ModelProfileScopeEditor.vue'),
  Thinking: path.join(sourceRoot, 'components/input/SessionThinkingControl.vue'),
  Composer: path.join(sourceRoot, 'components/input/Composer.vue'),
  Tools: path.join(sourceRoot, 'components/settings/tools/ToolPolicyEditor.vue')
};
const testedComponents = new Set(Object.values(componentFiles));
const presentation = { __esModule: true, default: { render() { return null; } } };
export function createClock() {
  const timers = new Map(); let now = 0, serial = 0;
  return {
    setTimeout(callback, delay = 0, ...args) { const id = ++serial; timers.set(id, { at: now + delay, callback: () => callback(...args) }); return id; },
    clearTimeout(id) { timers.delete(id); },
    async advance(ms) {
      const end = now + ms;
      for (;;) {
        const next = [...timers].filter(([, entry]) => entry.at <= end).sort((a, b) => a[1].at - b[1].at)[0];
        if (!next) break;
        now = next[1].at; timers.delete(next[0]); await next[1].callback(); await Promise.resolve();
      }
      now = end;
    },
    dispose() { timers.clear(); }
  };
}
export async function createConfigurationUiGraph() {
  const previousWindow = globalThis.window, scripts = new Map();
  // Cache static compilation only; each session evaluates fresh module closures and stores.
  const scriptFor = filename => {
    if (scripts.has(filename)) return scripts.get(filename);
    let source = fs.readFileSync(filename, 'utf8');
    if (filename.endsWith('.vue')) source = compileScript(parse(source, { filename }).descriptor,
      { id: 'configuration-smoke', inlineTemplate: false }).content;
    const output = ts.transpileModule(source, { fileName: filename, compilerOptions: {
      module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true
    } }).outputText;
    const script = new vm.Script(`(function(require, module, exports, window, setTimeout, clearTimeout) {\n${output}\n})`, { filename });
    scripts.set(filename, script); return script;
  };
  const node = type => ({ type, props: {}, children: [] });
  const renderer = vue.createRenderer({ createElement: node, createText: () => node('#text'), createComment: () => node('#comment'),
    setText() {}, setElementText() {}, patchProp(item, key, _old, value) { item.props[key] = value; },
    insert(item, parent) { item.parent = parent; parent.children.push(item); },
    remove(item) { if (item.parent) item.parent.children.splice(item.parent.children.indexOf(item), 1); },
    parentNode: item => item.parent, nextSibling: () => null });
  return {
    vue,
    session(t) {
      const isolated = pinia.createPinia(), previousPinia = pinia.getActivePinia(); pinia.setActivePinia(isolated);
      const active = { clock: createClock(), messages: [], persisted: undefined }, listeners = new Map();
      const sessionWindow = {
        innerWidth: 1024, innerHeight: 768,
        addEventListener(type, callback) { const set = listeners.get(type) ?? new Set(); set.add(callback); listeners.set(type, set); },
        removeEventListener(type, callback) { listeners.get(type)?.delete(callback); },
        setTimeout: active.clock.setTimeout, clearTimeout: active.clock.clearTimeout,
        acquireVsCodeApi() { return {
          postMessage(message) { active.messages.push(structuredClone(message)); },
          getState() { return active.persisted; }, setState(value) { active.persisted = value; }
        }; }
      };
      globalThis.window = sessionWindow;
      t.mock.method(globalThis, 'setTimeout', active.clock.setTimeout); t.mock.method(globalThis, 'clearTimeout', active.clock.clearTimeout);
      const modules = new Map(), apps = [];
      t.after(() => {
        for (const app of apps) app.unmount();
        pinia.disposePinia(isolated); pinia.setActivePinia(previousPinia); active.clock.dispose(); listeners.clear(); modules.clear();
        if (previousWindow === undefined) delete globalThis.window; else globalThis.window = previousWindow;
      });
      const resolve = input => {
        if (fs.existsSync(input) && fs.statSync(input).isFile()) return input;
        if (fs.existsSync(`${input}.ts`)) return `${input}.ts`;
        return path.join(input, 'index.ts');
      };
      const load = filename => {
        if (modules.has(filename)) return modules.get(filename).exports;
        // These display leaves were never mounted or asserted by this suite.
        if (filename.endsWith('.vue') && !testedComponents.has(filename)) return presentation;
        const module = { exports: {} }; modules.set(filename, module);
        const localRequire = name => {
          if (name.startsWith('@shared/')) {
            const output = `shared/${name.slice(8)}.js`;
            return fs.existsSync(path.join(extensionRoot, output)) ? compiled(output) : load(resolve(path.resolve('shared', name.slice(8))));
          }
          if (name.startsWith('@webview/')) return load(resolve(path.join(sourceRoot, name.slice(9))));
          if (name.startsWith('.')) return load(resolve(path.resolve(path.dirname(filename), name)));
          if (name === '@tabler/icons-vue') return {};
          return require(name);
        };
        // Same realm keeps production plain-object checks; module/bridge state is session-local.
        scriptFor(filename).runInThisContext()(localRequire, module, module.exports, sessionWindow, active.clock.setTimeout, active.clock.clearTimeout);
        return module.exports;
      };
      const store = name => load(path.join(sourceRoot, `stores/${name}.ts`))[name](isolated);
      const f = { ...active, vue, pinia: isolated,
        client: store('useClientStateStore'), models: store('useModelProfileStore'), global: store('useGlobalSettingsStore'),
        conversation: store('useConversationSettingsStore'), prompts: store('useSystemPromptStore'), tools: store('useToolPolicyStore'), feed: store('useReliableKernelClientFeedStore'),
        mount(name, props = {}) {
          const component = { ...load(componentFiles[name]).default, render() { return null; } };
          const app = renderer.createApp(component, props).use(isolated), root = node('root');
          app.provide(vue.ssrContextKey, { modules: new Set() });
          const instance = app.mount(root); apps.push(app); return { view: instance.$.setupState, root };
        },
        messagesOf(type) { return active.messages.filter(message => message.type === type); },
        last(type) { return f.messagesOf(type).at(-1); }
      };
      return f;
    },
    async close() { scripts.clear(); }
  };
}
