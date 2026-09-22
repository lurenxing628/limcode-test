// Headless execution of production Pinia actions and Vue script-setup, not a rendered VS Code UI.
const fs = require('node:fs');
const vm = require('node:vm');
const ts = require('typescript');
const vue = require('vue');
const pinia = require('pinia');
const protocol = require('../../dist/extension/shared/protocol.js');

exports.createThinkingUi = function createThinkingUi(send) {
  pinia.setActivePinia(pinia.createPinia());
  const requests = [], timers = [];
  const client = vue.reactive({ modelProfiles: [], modelProfileScopeLinks: [] });
  let store;
  const bridge = { request(type, payload) { const id = `ui-${requests.length}`; const message = { id, type, payload: structuredClone(payload) }; requests.push(message); send(message); return id; } };
  function load(file, props, names) {
    let source = fs.readFileSync(file, 'utf8');
    if (props) source = source.match(/<script setup lang="ts">([\s\S]*?)<\/script>/)[1] + `\nexport { ${names.join(',')} };`;
    const module = { exports: {} };
    vm.runInNewContext(ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText, {
      module, exports: module.exports, console, defineProps: () => props,
      setTimeout(callback, ms) { const timer = setTimeout(callback, ms); timer.unref(); timers.push(timer); return timer; },
      require(name) {
        if (name === 'vue') return vue;
        if (name === 'pinia') return pinia;
        if (name === '@shared/protocol') return protocol;
        if (name.startsWith('@shared/')) return require('../../dist/extension/shared/' + name.slice(8) + '.js');
        if (name === '@webview/transport') return { bridge, BridgeMessageType: protocol.BridgeMessageType };
        if (name === './useClientStateStore') return { useClientStateStore: () => client };
        if (name === '@webview/stores/useModelProfileStore') return { useModelProfileStore: () => store };
        if (name.endsWith('.vue')) return {};
        throw new Error(`Unexpected UI dependency: ${name}`);
      }
    });
    return module.exports;
  }
  store = load('webview/src/stores/useModelProfileStore.ts').useModelProfileStore();
  return {
    store, requests,
    receive(message) { if (message.type === protocol.BridgeMessageType.ModelProfileScopeSnapshot) store.applyScopeSnapshot(message.payload, message.correlationId); },
    control(config, model, conversationId = 'parent') { return load('webview/src/components/input/SessionThinkingControl.vue', vue.reactive({ config, model, conversationId, recent: '' }), ['save', 'selected', 'capability', 'defaultLabel', 'error']); },
    dispose() { for (const timer of timers) clearTimeout(timer); }
  };
};
