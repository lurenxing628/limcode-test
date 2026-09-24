import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const assert = require('node:assert/strict');
const fs = require('node:fs');
const test = require('node:test');
const vm = require('node:vm');
const ts = require('typescript');
const vue = require('vue');
const { parse, compileScript } = require('@vue/compiler-sfc');
const { baseParse } = require('@vue/compiler-dom');

const composerPath = 'webview/src/components/input/Composer.vue';
const controlPath = 'webview/src/components/input/SessionThinkingControl.vue';
function elements(node) { return [...(node.type === 1 ? [node] : []), ...(node.children ?? []).flatMap(elements)]; }
function templateElements(path) { return elements(baseParse(parse(fs.readFileSync(path, 'utf8')).descriptor.template.content)); }
function attribute(node, name) { return node.props.find(prop => prop.type === 6 && prop.name === name)?.value?.content; }

// Execute the actual component script and shared capability helpers without compiled dist artifacts.
function fixture(overrides = {}) {
  const writes = [], reads = [];
  const state = vue.reactive({ thinking: undefined, inherit: false, pending: undefined, error: '', ...overrides.state });
  const store = {
    thinkingFor: () => state.thinking,
    childThinkingInheritanceFor: () => state.inherit,
    pendingFor: () => state.pending,
    errorFor: () => state.error,
    confirmedFor: () => state.observation,
    readingFor: () => false,
    setThinkingForScope: (...args) => writes.push(['thinking', ...args]),
    setChildThinkingInheritance: (...args) => writes.push(['inherit', ...args]),
    retryPending: (...args) => reads.push(['retry', ...args]),
    refreshScope: (...args) => reads.push(['refresh', ...args])
  };
  const props = vue.reactive({ conversationId: 'a', model: 'o3', config: { id: 'channel', provider: 'openai-compatible', model: 'o3', modelConfigs: [] }, ...overrides.props });
  const dropdown = { props: ['modelValue', 'options', 'disabled'], emits: ['update:modelValue'], setup: (props, { emit, slots }) => () => vue.h('div', [
    vue.h('select', { value: props.modelValue, disabled: props.disabled, onChange: event => emit('update:modelValue', event.target.value) }, props.options.map(option => vue.h('option', { value: option.value }, option.label))),
    ...(slots.footer?.() ?? [])
  ]) };
  function load(path, component = false) {
    let source = fs.readFileSync(path, 'utf8');
    if (component === 'render') source = compileScript(parse(source).descriptor, { id: 'thinking-test', inlineTemplate: true }).content;
    else if (component) source = parse(source).descriptor.scriptSetup.content + '\nexport { options, displayOptions, selected, defaultLabel, hint, inheritChildren, disabled, error, save, setInheritance, retry, panelOffset };';
    const module = { exports: {} };
    vm.runInNewContext(ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText, {
      module, exports: module.exports, defineProps: () => props, URL,
      require(name) {
        if (name === 'vue') return vue;
        if (name === '@webview/stores/useModelProfileStore') return { useModelProfileStore: () => store };
        if (name.endsWith('/LcCheckbox.vue')) return load('webview/src/components/ui/LcCheckbox.vue', 'render');
        if (name.endsWith('.vue')) return { default: dropdown };
        if (name.startsWith('@shared/')) return load('shared/' + name.slice(8) + '.ts');
        if (name.startsWith('./')) return load('shared/' + name.slice(2) + '.ts');
        throw new Error(`Unexpected dependency ${name}`);
      }
    });
    return module.exports;
  }
  return { control: load(controlPath, true), component: () => load(controlPath, 'render').default, props, state, writes, reads };
}
const plain = value => JSON.parse(JSON.stringify(value));

test('Composer renders one thinking control beside model/workspace selectors, without a save operation bar', () => {
  const source = fs.readFileSync(composerPath, 'utf8');
  const nodes = templateElements(composerPath);
  const controls = nodes.filter(node => node.tag === 'SessionThinkingControl');
  assert.equal(controls.length, 1);
  assert.doesNotMatch(source, /ModelProfileSaveStatus/);
  const row = nodes.find(node => attribute(node, 'class')?.split(' ').includes('composer-meta'));
  assert.ok(elements(row).includes(controls[0]));
  assert.match(source, /activateScope\('conversation', conversationId\)/);
  assert.match(source, /:model="confirmedEffectiveModel\?\.model/);
});

test('Thinking UI is one dropdown whose panel footer holds the child-inheritance checkbox, plus an inline retry', () => {
  const nodes = templateElements(controlPath);
  assert.equal(nodes.filter(node => node.tag === 'SettingsDropdown' || node.tag === 'select').length, 1);
  assert.equal(nodes.filter(node => node.tag === 'input').length, 0);
  assert.equal(nodes.filter(node => node.tag === 'LcCheckbox').length, 1, 'use the shared accessible checkbox');
  const dropdown = nodes.find(node => node.tag === 'SettingsDropdown');
  const footer = elements(dropdown).find(node => node.tag === 'template' && node.props?.some(prop => prop.name === 'slot' && prop.arg?.content === 'footer'));
  assert.ok(footer, 'the checkbox lives in the dropdown footer instead of wrapping below the control');
  assert.ok(elements(footer).some(node => node.tag === 'LcCheckbox'));
  const source = fs.readFileSync(controlPath, 'utf8');
  assert.match(source, /派出的子 Agent 也用这个思考强度/);
  assert.match(source, /不勾选时，子 Agent 按它自己的 Agent 设置/);
  assert.doesNotMatch(source, /子继承|服务默认|flex-wrap: wrap/);
  assert.match(source, /重试/);
  assert.doesNotMatch(source, /ModelProfileSaveStatus|应用|放弃草稿|重新接入/);
});

test('Default option says it follows the channel and shows the value the channel sends', () => {
  const f = fixture();
  assert.equal(f.control.defaultLabel.value, '跟随渠道设置：未设置（由服务决定）');
  assert.equal(f.control.selected.value, 'default');
  assert.equal(f.control.options.value[0].buttonLabel, '思考：跟随渠道');
  f.props.config.generationConfig = { thinkingConfig: { thinkingLevel: 'high' } };
  assert.equal(f.control.defaultLabel.value, '跟随渠道设置：high');
  assert.equal(f.control.options.value[0].buttonLabel, '思考：跟随渠道（high）');
  f.props.config.modelConfigs = [{ modelId: 'o3', generationConfig: {} }];
  assert.equal(f.control.defaultLabel.value, '跟随渠道设置：未设置（由服务决定）', 'model config replaces channel defaults');
});

test('Level options read as plain Chinese with the wire value in brackets; the button marks child inheritance', () => {
  const f = fixture();
  const high = f.control.options.value.find(option => option.value === 'high');
  assert.equal(high.label, '高（high）');
  assert.equal(high.buttonLabel, '思考：高');
  const none = f.control.options.value.find(option => option.value === 'none');
  if (none) assert.equal(none.label, '关闭思考');
  assert.equal(f.control.displayOptions.value.find(option => option.value === 'high').buttonLabel, '思考：高');
  f.state.inherit = true;
  assert.equal(f.control.displayOptions.value.find(option => option.value === 'high').buttonLabel, '思考：高 · 含子 Agent');
  assert.match(f.control.hint.value, /不影响其他对话/);
  assert.match(f.control.hint.value, /子 Agent 也使用这里的选择/);
});

test('Budget defaults remain visible; unknown and unsupported model shortcuts remain disabled', () => {
  const f = fixture({ props: { model: 'gemini-2.5-flash', config: { id: 'gemini', provider: 'gemini', modelConfigs: [], generationConfig: { thinkingConfig: { thinkingBudget: 1024 } } } } });
  assert.equal(f.control.defaultLabel.value, '跟随渠道设置：1024 tokens');
  assert.equal(f.control.options.value.find(option => option.value === '2048').label, '思考预算 2048 tokens');
  for (const [model, label] of [
    ['gemini-2.0-flash', '跟随渠道设置：能力未确认 · 1024 tokens'],
    ['gemini-9-flash', '跟随渠道设置：能力未确认 · 1024 tokens'],
    ['unknown-relay', '跟随渠道设置：不支持（不发送）']
  ]) {
    f.props.model = model;
    assert.equal(f.control.defaultLabel.value, label);
    assert.equal(f.control.disabled.value, true);
    assert.deepEqual(plain(f.control.options.value).map(option => [option.value, option.label]), [['default', label]]);
  }
});

test('Dropdown saves immediately, default resets, child checkbox reads and writes explicit boolean', () => {
  const f = fixture();
  assert.equal(f.control.inheritChildren.value, false);
  f.control.save('high');
  assert.deepEqual(plain(f.writes[0]), ['thinking', 'a', { providerConfigId: 'channel', provider: 'openai-compatible', model: 'o3' }, { kind: 'openai-effort', value: 'high' }]);
  f.control.save('default');
  assert.equal(f.writes[1][3], null);
  f.state.inherit = true;
  assert.equal(f.control.inheritChildren.value, true);
  f.control.setInheritance(false);
  assert.deepEqual(plain(f.writes[2]), ['inherit', 'a', { providerConfigId: 'channel', provider: 'openai-compatible', model: 'o3' }, false]);
  f.props.conversationId = 'b';
  f.control.setInheritance(true);
  assert.equal(f.writes[3][1], 'b');
  assert.equal(f.writes[3][3], true);
});

test('Errors retain the repair reason; explicit read retry renews the editing session', () => {
  const f = fixture({ state: { pending: { status: 'uncertain', error: 'authority/root internals long error' } } });
  assert.equal(f.control.error.value, 'authority/root internals long error');
  f.control.retry();
  assert.deepEqual(f.reads, [['retry', 'conversation', 'a']]);
  f.state.pending = undefined;
  f.state.error = 'internal read error';
  assert.equal(f.control.error.value, 'internal read error');
  f.control.retry();
  assert.deepEqual(plain(f.reads[1]), ['refresh', 'conversation', 'a', { adoptRoot: true }]);
});

// Minimal host renderer mounts the real SFC template; no browser/VS Code visual claims.
function mountControl(component, props) {
  const node = (type, text = '') => ({ type, text, props: {}, children: [] });
  const renderer = vue.createRenderer({
    createElement: node, createText: text => node('#text', text), createComment: text => node('#comment', text),
    setText: (item, text) => { item.text = text; }, setElementText: (item, text) => { item.text = text; item.children = []; },
    patchProp: (item, key, _previous, next) => { item.props[key] = next; },
    insert(item, parent, anchor) { item.parent = parent; const index = parent.children.indexOf(anchor); parent.children.splice(index < 0 ? parent.children.length : index, 0, item); },
    remove(item) { item.parent.children.splice(item.parent.children.indexOf(item), 1); },
    parentNode: item => item.parent, nextSibling: () => null
  });
  const root = node('root');
  const app = renderer.createApp({ setup: () => () => vue.h(component, props) });
  app.mount(root);
  const all = item => [item, ...item.children.flatMap(all)];
  return { find: type => all(root).filter(item => item.type === type), dispose: () => app.unmount() };
}

test('Mounted template binds dropdown change and checkbox checked/change to the current scope', async () => {
  const f = fixture();
  const mounted = mountControl(f.component(), f.props);
  try {
    assert.equal(mounted.find('select').length, 1);
    assert.equal(mounted.find('button').find(item => item.props.role === 'checkbox').props['aria-checked'], false);
    mounted.find('select')[0].props.onChange({ target: { value: 'high' } });
    assert.equal(f.writes[0][3].value, 'high');
    mounted.find('button').find(item => item.props.role === 'checkbox').props.onClick();
    assert.equal(f.writes[1][3], true);
    f.state.inherit = true;
    await vue.nextTick();
    assert.equal(mounted.find('button').find(item => item.props.role === 'checkbox').props['aria-checked'], true);
    f.props.model = 'gpt-4o';
    await vue.nextTick();
    assert.equal(mounted.find('select')[0].props.disabled, false, 'still openable so child inheritance can be turned off');
    f.state.inherit = false;
    await vue.nextTick();
    assert.equal(mounted.find('select')[0].props.disabled, true);
    assert.equal(mounted.find('option')[0].text, '跟随渠道设置：未设置（由服务决定）');
  } finally { mounted.dispose(); }
});

function composerSubmission() {
  const source = parse(fs.readFileSync(composerPath, 'utf8')).descriptor.scriptSetup.content;
  const ast = ts.createSourceFile('Composer.ts', source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  const names = ['savingSessionSelections', 'savingSessionSelection', 'conversationInputDisabled'];
  const parts = ast.statements.filter(statement => ts.isFunctionDeclaration(statement) ? statement.name?.text === 'submit'
    : ts.isVariableStatement(statement) && statement.declarationList.declarations.some(item => names.includes(item.name.getText(ast))));
  const code = parts.map(part => part.getText(ast)).join('\n') + '\nmodule.exports = { submit };';
  const module = { exports: {} }, sent = [], clientState = vue.reactive({ currentConversationId: 'a' });
  let release, reject;
  const waiting = new Promise((resolve, fail) => { release = resolve; reject = fail; });
  const draft = vue.ref('message');
  vm.runInNewContext(ts.transpileModule(code, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS } }).outputText, {
    module, computed: vue.computed, ref: vue.ref, clientState, props: { disabled: false }, draft,
    modelProfileStore: { awaitSavedForScope: (_kind, id) => id === 'a' ? waiting : Promise.resolve() },
    currentSubmissionCommandId: vue.ref(), currentSteeringSubmitting: vue.ref(false), selectedAttachments: vue.ref([]),
    buildMessageContent: text => ({ text }), ui: { isEditing: false }, nativeSteeringAvailable: vue.ref(false),
    currentTurnAuthoritySelection: () => ({}), sendMessage: text => { sent.push({ id: clientState.currentConversationId, text }); }
  });
  return { ...module.exports, sent, release, reject, clientState, draft };
}

test('Composer waits for saved settings and never sends into a newly navigated conversation', async () => {
  const f = composerSubmission();
  const sending = f.submit();
  assert.equal(f.sent.length, 0);
  f.clientState.currentConversationId = 'b';
  await f.submit();
  assert.deepEqual(f.sent, [{ id: 'b', text: 'message' }]);
  f.release();
  await sending;
  assert.equal(f.sent.length, 1);
});

test('Composer save rejection does not send with old thinking settings', async () => {
  const f = composerSubmission();
  const sending = f.submit();
  assert.equal(f.sent.length, 0);
  f.reject(new Error('save failed'));
  await sending;
  assert.equal(f.sent.length, 0);
});

test('A saved effort the current model does not accept shows as inactive, and choosing the channel default really resets it', () => {
  const f = fixture({ state: { thinking: { kind: 'openai-effort', value: 'minimal' } } });
  assert.equal(f.control.selected.value, 'saved-inactive', 'o3 does not expose the previous GPT-5 minimal option');
  const inactive = f.control.options.value.find(option => option.value === 'saved-inactive');
  assert.equal(inactive.label, '已保存：最低（当前不生效）');
  assert.equal(inactive.disabled, true);
  assert.match(inactive.description, /已保存的思考强度不适用于当前模型，已按渠道设置发送/);
  assert.match(f.control.hint.value, /已保存的思考强度不适用于当前模型/);
  f.control.save('minimal');
  f.control.save('saved-inactive');
  assert.equal(f.writes.length, 0);
  f.control.save('default');
  assert.deepEqual(plain(f.writes[0]), ['thinking', 'a', { providerConfigId: 'channel', provider: 'openai-compatible', model: 'o3' }, null]);
});

test('Legacy overrides: an effort kind renamed by the upgrade stays selected; Opus 5.5 none can be cleared even though the model has options', () => {
  const deepseek = { id: 'channel', provider: 'openai-compatible', baseUrl: 'https://api.deepseek.com/v1', model: 'deepseek-v4-pro', models: [{ id: 'deepseek-v4-pro', name: 'DeepSeek' }], modelConfigs: [] };
  const renamed = fixture({ props: { model: 'deepseek-v4-pro', config: deepseek }, state: { thinking: { kind: 'openai-effort', value: 'high' } } });
  assert.equal(renamed.control.selected.value, 'high');
  const opus = fixture({ props: { model: 'claude-opus-5-5', config: { id: 'claude', provider: 'claude', model: 'claude-opus-5-5', models: [], modelConfigs: [] } }, state: { thinking: { kind: 'claude-effort', value: 'none' } } });
  assert.equal(opus.control.selected.value, 'saved-inactive');
  assert.equal(opus.control.options.value.find(option => option.value === 'saved-inactive').label, '已保存：关闭思考（当前不生效）');
  assert.equal(opus.control.disabled.value, false);
  opus.control.save('default');
  assert.equal(opus.writes[0][3], null);
});

test('A stale override on a model without options can still be reset; the child checkbox stays reachable while it is on', () => {
  const f = fixture({ props: { model: 'gpt-4o' }, state: { thinking: { kind: 'openai-effort', value: 'high' } } });
  assert.equal(f.control.selected.value, 'saved-inactive');
  assert.equal(f.control.disabled.value, false);
  f.control.save('default');
  assert.equal(f.writes[0][3], null);
  const plainModel = fixture({ props: { model: 'gpt-4o' } });
  assert.equal(plainModel.control.disabled.value, true);
  plainModel.state.inherit = true;
  assert.equal(plainModel.control.disabled.value, false, 'the checkbox lives in the panel; keep it openable so inheritance can be turned off');
});

test('Following the channel does not claim child Agents use a session choice', () => {
  const f = fixture({ state: { inherit: true } });
  assert.equal(f.control.displayOptions.value.find(option => option.value === 'default').buttonLabel, '思考：跟随渠道');
  assert.equal(f.control.displayOptions.value.find(option => option.value === 'high').buttonLabel, '思考：高 · 含子 Agent');
});

test('The dropdown panel is shifted left so it never runs past the right edge of the window', () => {
  const f = fixture();
  assert.equal(f.control.panelOffset(10, 120, 1000), 0);
  assert.equal(f.control.panelOffset(900, 120, 1000), 1000 - 8 - (900 + 280));
  assert.equal(f.control.panelOffset(150, 120, 250), 8 - 150, 'narrow window: pinned to the left margin');
  const source = fs.readFileSync(controlPath, 'utf8');
  assert.match(source, /left: var\(--session-thinking-panel-left, 0px\)/);
  assert.match(source, /max-width: calc\(100vw - 16px\)/);
  assert.match(source, /@open="alignPanel"/);
});

test('OpenAI 兼容渠道的选项按渠道配置计算：硅基流动的 DeepSeek V4 只有 high / max', () => {
  const model = 'deepseek-ai/DeepSeek-V4-Pro';
  const f = fixture({ props: { model, config: { id: 'channel', provider: 'openai-compatible', baseUrl: 'https://api.siliconflow.cn/v1', model, models: [{ id: model, name: model }], modelConfigs: [] } } });
  assert.deepEqual(plain(f.control.options.value).map(option => option.value), ['default', 'none', 'high', 'max']);
  f.control.save('high');
  assert.deepEqual(plain(f.writes[0][3]), { kind: 'deepseek-effort', value: 'high' });
});

test('The channel default label shows the value actually sent on OpenAI-compatible channels', () => {
  const model = 'deepseek-v4-pro';
  const f = fixture({ props: { model, config: { id: 'channel', provider: 'openai-compatible', baseUrl: 'https://api.deepseek.com/v1', model, models: [{ id: model, name: model }], modelConfigs: [], generationConfig: { thinkingConfig: { thinkingLevel: 'medium' } } } } });
  assert.equal(f.control.defaultLabel.value, '跟随渠道设置：medium，实际发 high');
  assert.equal(f.control.options.value[0].buttonLabel, '思考：跟随渠道（medium，实际发 high）');
});
