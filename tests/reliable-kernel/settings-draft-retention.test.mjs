import assert from 'node:assert/strict';
import { before, after, test } from 'node:test';
import { createWebviewSsrServer } from './webview-ssr-server.mjs';

let server, vue, pinia, useClient, useConversation, useProfiles, useGlobal;
const panels = {}, posted = [];
const previousWindow = globalThis.window;
before(async () => {
  globalThis.window = {
    addEventListener() {}, removeEventListener() {}, setTimeout() { return 0; }, clearTimeout() {},
    acquireVsCodeApi() { return { postMessage(m) { posted.push(m); }, getState() {}, setState() {} }; }
  };
  server = await createWebviewSsrServer();
  vue = await import('vue'); pinia = await import('pinia');
  ({ useClientStateStore: useClient } = await server.ssrLoadModule('/src/stores/useClientStateStore.ts'));
  ({ useConversationSettingsStore: useConversation } = await server.ssrLoadModule('/src/stores/useConversationSettingsStore.ts'));
  ({ useModelProfileStore: useProfiles } = await server.ssrLoadModule('/src/stores/useModelProfileStore.ts'));
  ({ useGlobalSettingsStore: useGlobal } = await server.ssrLoadModule('/src/stores/useGlobalSettingsStore.ts'));
  for (const name of ['SystemPromptScopeEditor', 'RuntimeContextScopeEditor', 'ModelProfileScopeEditor']) {
    panels[name] = (await server.ssrLoadModule(`/src/components/settings/config/${name}.vue`)).default;
  }
});
after(async () => { await server?.close(); globalThis.window = previousWindow; });

function fixture(t) {
  const store = pinia.createPinia(); pinia.setActivePinia(store);
  const client = useClient(); const mounted = [], timers = [];
  const originalSetTimeout = globalThis.setTimeout;
  globalThis.setTimeout = (...args) => { const timer = originalSetTimeout(...args); timers.push(timer); return timer; };
  t.after(() => {
    for (const app of mounted) app.unmount();
    for (const timer of timers) clearTimeout(timer);
    globalThis.setTimeout = originalSetTimeout;
    pinia.disposePinia(store);
  });
  client.systemPrompts = [{ id: 'prompt', name: 'fixture', text: 'saved prompt' }];
  client.systemPromptScopeLinks = [{ id: 'prompt-link', scopeKind: 'conversation', scopeId: 'c', systemPromptId: 'prompt', role: 'active', createdAt: 1, updatedAt: 1 }];
  client.runtimeContexts = [{ id: 'runtime', name: 'fixture', template: 'saved runtime' }];
  client.runtimeContextScopeLinks = [{ id: 'runtime-link', scopeKind: 'conversation', scopeId: 'c', runtimeContextId: 'runtime', role: 'active', createdAt: 1, updatedAt: 1 }];
  const renderer = vue.createRenderer({ createElement: () => ({}), createText: () => ({}), createComment: () => ({}),
    setText() {}, setElementText() {}, parentNode() { return null; }, nextSibling() { return null; }, insert() {}, remove() {}, patchProp() {} });
  return {
    client,
    snapshot() { client.applyConfigurationSnapshot(JSON.parse(JSON.stringify(client.$state))); },
    mount(name, props = { scopeKind: 'conversation', scopeId: 'c' }) {
      // Keep the actual SFC setup and watchers live; the renderer replaces only DOM presentation.
      const app = renderer.createApp({ ...panels[name], render() { return null; }, ssrRender: undefined }, props).use(store);
      app.provide(vue.ssrContextKey, { modules: new Set() });
      mounted.push(app); return app.mount({}).$.setupState;
    }
  };
}

for (const [component, catalog, field] of [
  ['SystemPromptScopeEditor', 'systemPrompts', 'text'],
  ['RuntimeContextScopeEditor', 'runtimeContexts', 'template']
]) {
  test(`${component}: identical snapshots and late save ACK preserve a newer draft`, async t => {
    const h = fixture(t), view = h.mount(component);
    view.draft = 'first submitted edit'; view.save();
    view.draft = 'newer unsaved edit'; h.snapshot();
    await vue.nextTick(); assert.equal(view.draft, 'newer unsaved edit');
    h.client[catalog][0][field] = 'first submitted edit';
    await vue.nextTick();
    assert.equal(view.draft, 'newer unsaved edit'); assert.equal(view.draftChangedRemotely, true);
    view.draftState.reset();
    assert.equal(view.draft, 'first submitted edit'); assert.equal(view.draftChangedRemotely, false);
    h.client[catalog][0][field] = 'new saved value';
    await vue.nextTick(); assert.equal(view.draft, 'new saved value', 'a clean editor follows real saved changes');
  });
  test(`${component}: returning to the old baseline after Save is still a newer edit`, async t => {
    const h = fixture(t), view = h.mount(component), original = view.draft;
    view.draft = 'submitted edit'; view.save(); view.draft = original;
    h.client[catalog][0][field] = 'submitted edit'; await vue.nextTick();
    assert.equal(view.draft, original); assert.equal(view.draftChangedRemotely, true);
  });
  test(`${component}: an older save confirmation cannot replace a newer submitted baseline value`, async t => {
    const h = fixture(t), view = h.mount(component), original = view.draft;
    view.draft = 'first save'; view.save(); view.draft = original; view.save();
    h.client[catalog][0][field] = 'first save'; await vue.nextTick();
    assert.equal(view.draft, original);
    h.client[catalog][0][field] = original; await vue.nextTick();
    assert.equal(view.draft, original); assert.equal(view.draftState.dirty.value, false);
  });
}

test('customizing an inherited prompt remains a draft even when its text initially matches inheritance', async t => {
  const h = fixture(t);
  h.client.systemPrompts = [{ id: 'global', name: 'fixture', text: 'inherited text' }];
  h.client.systemPromptScopeLinks = [{ id: 'global-link', scopeKind: 'global', systemPromptId: 'global', role: 'active', createdAt: 1, updatedAt: 1 }];
  const view = h.mount('SystemPromptScopeEditor');
  assert.equal(view.inheritMode, true); view.startCustom();
  h.client.systemPrompts[0].text = 'changed upstream'; await vue.nextTick();
  assert.equal(view.inheritMode, false); assert.equal(view.draft, 'inherited text');
  view.draftState.reset(); assert.equal(view.inheritMode, true); assert.equal(view.draft, 'changed upstream');
});

test('initial configuration load does not overwrite a draft typed before it arrived', async t => {
  const h = fixture(t); h.client.runtimeContextScopeLinks = [];
  const view = h.mount('RuntimeContextScopeEditor'); view.draft = 'typed before load';
  h.client.runtimeContextScopeLinks = [{ id: 'runtime-link', scopeKind: 'conversation', scopeId: 'c', runtimeContextId: 'runtime', role: 'active', createdAt: 1, updatedAt: 1 }];
  await vue.nextTick(); assert.equal(view.draft, 'typed before load');
  assert.equal(view.draftChangedRemotely, true);
});

test('scope changes reset the editor while explicit restore resets both draft and saved baseline', async t => {
  const h = fixture(t), view = h.mount('RuntimeContextScopeEditor');
  view.draft = 'local draft'; view.clear();
  assert.equal(view.draft, ''); assert.equal(view.draftState.dirty.value, false);
  const { useGuardedSettingsDraft } = await server.ssrLoadModule('/src/composables/useGuardedSettingsDraft.ts');
  const scope = vue.effectScope(), scopeId = vue.ref('a'), saved = vue.ref('a-saved');
  const draft = scope.run(() => useGuardedSettingsDraft(() => scopeId.value, () => ({ text: saved.value })));
  draft.value.value = { text: 'a-draft' }; saved.value = 'b-saved'; scopeId.value = 'b';
  assert.equal(draft.value.value.text, 'b-saved'); assert.equal(draft.dirty.value, false);
  scope.stop();
});

test('model settings retain an unsaved model when the same provider catalog is refreshed', async t => {
  const h = fixture(t), models = useProfiles(), global = useGlobal();
  global.llmProviderConfigs.configs = [{ id: 'provider', name: 'fixture', provider: 'openai', model: 'saved-model' }];
  const key = JSON.stringify({ scopeKind: 'conversation', scopeId: 'c' });
  models.authorityId = 'authority';
  models.observations[key] = { authorityId: 'authority', sessionId: 'session', revision: '1', sequence: 1,
    profile: { id: 'profile', name: 'fixture', providerConfigId: 'provider', provider: 'openai', model: 'saved-model' } };
  const view = h.mount('ModelProfileScopeEditor'); view.model = 'unsaved-model';
  global.llmProviderConfigs.configs = global.llmProviderConfigs.configs.map(item => ({ ...item }));
  await vue.nextTick(); assert.equal(view.model, 'unsaved-model');
  models.observations[key].profile.model = 'other-saved-model'; await vue.nextTick();
  assert.equal(view.model, 'unsaved-model'); assert.equal(view.draftChangedRemotely, true);
});

test('model inheritance clear ACK cannot overwrite a newer selection back to the saved model', async t => {
  const h = fixture(t), models = useProfiles(), global = useGlobal();
  global.llmProviderConfigs.configs = [{ id: 'provider', name: 'fixture', provider: 'openai-compatible', model: 'saved-model' }];
  const key = JSON.stringify({ scopeKind: 'conversation', scopeId: 'c' });
  models.authorityId = 'authority';
  models.observations[key] = { authorityId: 'authority', sessionId: 'session', revision: '1', sequence: 1,
    profile: { id: 'profile', name: 'fixture', providerConfigId: 'provider', provider: 'openai-compatible', model: 'saved-model' } };
  const view = h.mount('ModelProfileScopeEditor');
  view.selectedProviderConfigId = '__inherit_global_model__';
  assert.equal(posted.at(-1).type, 'modelProfile.scope.clear');
  view.selectedProviderConfigId = 'provider';
  assert.equal(view.model, 'saved-model');
  models.observations[key].profile = undefined;
  await vue.nextTick();
  assert.equal(view.providerConfigId, 'provider'); assert.equal(view.model, 'saved-model');
  assert.equal(view.draftChangedRemotely, true);
});

const snapshot = (conversationId, name) => ({ conversationId, section: 'common', settings: { conversationId, name }, filePath: '' });
test('conversation rename ACK preserves newer edits and explicit reload is fenced against edits made while loading', t => {
  fixture(t); const settings = useConversation();
  settings.request('c'); settings.applySnapshot(snapshot('c', 'original'));
  settings.common.name = 'submitted'; settings.save(); settings.common.name = 'newer draft';
  settings.applySnapshot(snapshot('c', 'submitted'));
  assert.equal(settings.common.name, 'newer draft'); assert.equal(settings.savedName, 'submitted');
  settings.request('c', true); const firstRead = posted.at(-1).id;
  settings.common.name = 'typed after reload'; settings.applySnapshot(snapshot('c', 'submitted'), firstRead);
  assert.equal(settings.common.name, 'typed after reload');
  settings.request('c', true); settings.applySnapshot(snapshot('c', 'submitted'), posted.at(-1).id);
  assert.equal(settings.common.name, 'submitted');
  settings.request('other'); settings.applySnapshot(snapshot('c', 'late old conversation'));
  assert.equal(settings.common.conversationId, 'other'); assert.equal(settings.common.name, '');
});

test('conversation initial read and repeated unchanged snapshots do not erase an unsaved name', t => {
  fixture(t); const settings = useConversation(); settings.request('c'); settings.common.name = 'early draft';
  settings.applySnapshot(snapshot('c', 'saved')); settings.applySnapshot(snapshot('c', 'saved'));
  assert.equal(settings.common.name, 'early draft');
  settings.common.name = 'saved'; settings.applySnapshot(snapshot('c', 'new saved'));
  assert.equal(settings.common.name, 'new saved');
});

test('conversation save fences a newer edit back to baseline and overlapping save acknowledgements', t => {
  fixture(t); const settings = useConversation(); settings.request('c'); settings.applySnapshot(snapshot('c', 'original'));
  settings.common.name = 'first save'; settings.save(); const first = posted.at(-1).id;
  settings.common.name = 'original'; settings.applySnapshot(snapshot('c', 'first save'), first);
  assert.equal(settings.common.name, 'original');
  settings.request('c', true); settings.applySnapshot(snapshot('c', 'original'), posted.at(-1).id);
  settings.common.name = 'second save'; settings.save(); const second = posted.at(-1).id;
  settings.common.name = 'original'; settings.save(); const third = posted.at(-1).id;
  settings.applySnapshot(snapshot('c', 'second save'), second); assert.equal(settings.common.name, 'original');
  settings.applySnapshot(snapshot('c', 'original'), third); assert.equal(settings.common.name, 'original');
  assert.equal(settings.pendingSave, undefined);
});
