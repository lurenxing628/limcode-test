import assert from 'node:assert/strict';
import { before, after, test } from 'node:test';
import { createWebviewSsrServer } from './webview-ssr-server.mjs';

let server, vue, pinia, useClient, useConversation, useProfiles, useGlobal, usePrompts, useRuntime;
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
  ({ useSystemPromptStore: usePrompts } = await server.ssrLoadModule('/src/stores/useSystemPromptStore.ts'));
  ({ useRuntimeContextStore: useRuntime } = await server.ssrLoadModule('/src/stores/useRuntimeContextStore.ts'));
  for (const name of ['SystemPromptScopeEditor', 'RuntimeContextScopeEditor', 'ModelProfileScopeEditor']) {
    panels[name] = (await server.ssrLoadModule(`/src/components/settings/config/${name}.vue`)).default;
  }
  panels.ConversationSettingsPanel = (await server.ssrLoadModule('/src/components/settings/ConversationSettingsPanel.vue')).default;
  panels.ChannelSettingsTab = (await server.ssrLoadModule('/src/components/settings/global/ChannelSettingsTab.vue')).default;
  panels.OtherSettingsTab = (await server.ssrLoadModule('/src/components/settings/global/OtherSettingsTab.vue')).default;
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

function reconcileScopeSave(component, requestId) {
  const client = useClient();
  const links = component === 'SystemPromptScopeEditor' ? 'systemPromptScopeLinks' : 'runtimeContextScopeLinks';
  for (const link of client[links]) link.updatedAt = Date.now();
  const store = component === 'SystemPromptScopeEditor' ? usePrompts() : useRuntime();
  store.reconcilePendingSave(requestId);
}

for (const [component, catalog, field] of [
  ['SystemPromptScopeEditor', 'systemPrompts', 'text'],
  ['RuntimeContextScopeEditor', 'runtimeContexts', 'template']
]) {
  test(`${component}: identical snapshots and late save ACK preserve a newer draft`, async t => {
    const h = fixture(t), view = h.mount(component);
    view.draft = 'first submitted edit'; view.save(); const requestId = posted.at(-1).id;
    view.draft = 'newer unsaved edit'; h.snapshot();
    await vue.nextTick(); assert.equal(view.draft, 'newer unsaved edit');
    h.client[catalog][0][field] = 'first submitted edit';
    reconcileScopeSave(component, requestId);
    await vue.nextTick();
    assert.equal(view.draft, 'newer unsaved edit'); assert.equal(view.draftChangedRemotely, true);
    view.draftState.reset();
    assert.equal(view.draft, 'first submitted edit'); assert.equal(view.draftChangedRemotely, false);
    h.client[catalog][0][field] = 'new saved value';
    await vue.nextTick(); assert.equal(view.draft, 'new saved value', 'a clean editor follows real saved changes');
  });
  test(`${component}: returning to the old baseline after Save is still a newer edit`, async t => {
    const h = fixture(t), view = h.mount(component), original = view.draft;
    view.draft = 'submitted edit'; view.save(); const requestId = posted.at(-1).id; view.draft = original;
    h.client[catalog][0][field] = 'submitted edit'; reconcileScopeSave(component, requestId); await vue.nextTick();
    assert.equal(view.draft, original); assert.equal(view.draftChangedRemotely, true);
  });
  test(`${component}: an older save confirmation cannot replace a newer submitted baseline value`, async t => {
    const h = fixture(t), view = h.mount(component), original = view.draft;
    view.draft = 'first save'; view.save(); const first = posted.at(-1).id;
    view.draft = original; view.save(); const second = posted.at(-1).id;
    h.client[catalog][0][field] = 'first save'; reconcileScopeSave(component, first); await vue.nextTick();
    assert.equal(view.draft, original);
    h.client[catalog][0][field] = original; reconcileScopeSave(component, second); await vue.nextTick();
    assert.equal(view.draft, original); assert.equal(view.draftState.dirty.value, false);
  });
  test(`${component}: Save then Clear cannot erase a newer edit matching the submitted text`, async t => {
    const h = fixture(t), view = h.mount(component);
    view.draft = 'submitted text'; view.save(); const setRequest = posted.at(-1).id;
    const setSnapshot = JSON.parse(JSON.stringify(h.client.$state));
    setSnapshot[catalog][0][field] = 'submitted text';
    const links = component === 'SystemPromptScopeEditor' ? 'systemPromptScopeLinks' : 'runtimeContextScopeLinks';
    const clearSnapshot = JSON.parse(JSON.stringify(setSnapshot));
    clearSnapshot[links] = [];
    clearSnapshot[catalog] = [];
    view.clear(); const clearRequest = posted.at(-1).id;
    if (component === 'SystemPromptScopeEditor') view.startCustom();
    view.draft = 'submitted text';
    h.client.applyConfigurationSnapshot(setSnapshot); reconcileScopeSave(component, setRequest); await vue.nextTick();
    assert.equal(view.draft, 'submitted text');
    h.client.applyConfigurationSnapshot(clearSnapshot); reconcileScopeSave(component, clearRequest); await vue.nextTick();
    assert.equal(view.draft, 'submitted text', 'the Clear acknowledgement must preserve input made after Clear');
    assert.equal(view.draftState.dirty.value, true);
    if (component === 'SystemPromptScopeEditor') assert.equal(view.inheritMode, false);
  });
  test(`${component}: reconnect fences old save acknowledgements and errors from the current draft`, async t => {
    const h = fixture(t), view = h.mount(component);
    const store = component === 'SystemPromptScopeEditor' ? usePrompts() : useRuntime();
    const key = JSON.stringify(['conversation', 'c']), otherKey = JSON.stringify(['agent', 'other']);
    view.draft = 'old submitted text'; view.save(); const oldRequest = posted.at(-1).id;
    const lateSnapshot = JSON.parse(JSON.stringify(h.client.$state));
    lateSnapshot[catalog][0][field] = 'old submitted text';
    store.resetPendingSaveForReconnect();
    assert.equal(store.pendingSaves[key], undefined); assert.equal(store.completedSaveFor('conversation', 'c'), undefined);
    view.draft = 'typed after reconnect'; view.draft = 'old submitted text';
    h.client.applyConfigurationSnapshot(lateSnapshot); reconcileScopeSave(component, oldRequest); await vue.nextTick();
    assert.equal(store.completedSaveFor('conversation', 'c'), undefined, 'the old Host request must not publish a save completion');
    assert.equal(view.draft, 'old submitted text');
    assert.equal(view.draftState.dirty.value, true, 'matching old submitted text is still a newer unacknowledged edit');
    view.draft = 'current submitted text'; view.save(); const currentRequest = posted.at(-1).id;
    const otherRequest = component === 'SystemPromptScopeEditor'
      ? store.setPromptForScope('agent', 'other', 'other submitted text')
      : store.setContextForScope('agent', 'other', 'other submitted text');
    store.rejectPendingSave(oldRequest, 'late old Host failure');
    store.rejectPendingSave(undefined, 'uncorrelated failure');
    assert.equal(store.pendingSaves[key].requestId, currentRequest);
    assert.equal(store.pendingSaves[otherKey].requestId, otherRequest);
    store.rejectPendingSave(otherRequest, 'other scope failure');
    assert.equal(store.pendingSaves[otherKey], undefined);
    assert.equal(store.pendingSaves[key].requestId, currentRequest, 'another scope rejection must leave the current submission pending');
    store.rejectPendingSave(currentRequest, 'current failure'); await vue.nextTick();
    assert.equal(store.pendingSaves[key], undefined);
    assert.equal(store.completedSaveFor('conversation', 'c'), undefined);
    assert.equal(view.draft, 'current submitted text'); assert.equal(view.draftState.dirty.value, true);
  });
}

test('prompt Clear ACK adopts the latest inherited text when no newer local edit was made', async t => {
  const h = fixture(t), store = usePrompts();
  h.client.systemPrompts.push({ id: 'global-prompt', name: 'global', text: 'upstream A' });
  h.client.systemPromptScopeLinks.push({ id: 'global-prompt-link', scopeKind: 'global', systemPromptId: 'global-prompt',
    role: 'active', createdAt: 1, updatedAt: 1 });
  const view = h.mount('SystemPromptScopeEditor');
  assert.equal(view.draft, 'saved prompt');
  view.clear(); const clearRequest = posted.at(-1).id;
  assert.equal(view.inheritMode, true); assert.equal(view.draft, 'upstream A');
  h.client.systemPrompts.find(prompt => prompt.id === 'global-prompt').text = 'upstream B';
  assert.equal(store.localPromptFor('conversation', 'c').prompt.text, 'saved prompt', 'the local saved override remains authoritative before the Clear ACK');
  const cleared = JSON.parse(JSON.stringify(h.client.$state));
  cleared.systemPrompts = cleared.systemPrompts.filter(prompt => prompt.id !== 'prompt');
  cleared.systemPromptScopeLinks = cleared.systemPromptScopeLinks.filter(link => link.scopeKind !== 'conversation' || link.scopeId !== 'c');
  h.client.applyConfigurationSnapshot(cleared); reconcileScopeSave('SystemPromptScopeEditor', clearRequest); await vue.nextTick();
  assert.equal(store.completedSaveFor('conversation', 'c'), clearRequest);
  assert.equal(view.draft, 'upstream B'); assert.equal(view.inheritMode, true);
  assert.equal(view.draftState.dirty.value, false);
});

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
  view.draft = 'local draft'; view.clear(); const clearRequest = posted.at(-1).id;
  assert.equal(view.draft, ''); assert.equal(view.draftState.dirty.value, true, 'wait for the Clear acknowledgement');
  const cleared = JSON.parse(JSON.stringify(h.client.$state));
  cleared.runtimeContexts = []; cleared.runtimeContextScopeLinks = [];
  h.client.applyConfigurationSnapshot(cleared); reconcileScopeSave('RuntimeContextScopeEditor', clearRequest); await vue.nextTick();
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

function confirmedModelFixture(t, scopeKind = 'agent', profileState = 'default') {
  const h = fixture(t), models = useProfiles(), global = useGlobal();
  global.llmProviderConfigs.configs = [{ id: 'provider', name: 'fixture', provider: 'openai-compatible', model: 'A' }];
  const scope = { scopeKind, scopeId: scopeKind === 'agent' ? 'agent' : 'c' };
  const profile = { id: `${scopeKind}-profile`, name: `${scopeKind} Model Profile`, providerConfigId: 'provider', provider: 'openai-compatible', model: 'A',
    ...(profileState === 'inherit-model' ? { inheritModel: true } : {}) };
  const link = { id: `${scopeKind}-profile-link`, ...scope, modelProfileId: profile.id, role: 'active', createdAt: 1, updatedAt: 1 };
  const base = { ...scope, authorityId: 'authority', sessionId: 'session',
    ...(profileState === 'absent' ? { profileState: 'absent' } : { profileState: 'default', profile, link }),
    ...(scopeKind === 'conversation' ? { effectiveModel: { providerConfigId: profile.providerConfigId, provider: profile.provider, model: profile.model } } : {}) };
  const view = h.mount('ModelProfileScopeEditor', scope);
  const read = posted.at(-1);
  assert.equal(read.type, 'modelProfile.scope.read');
  models.applyScopeSnapshot({ ...base, revision: '1', sequence: 1, outcome: 'observed' }, read.id);
  assert.equal(view.model, profileState === 'default' ? 'A' : ''); assert.equal(view.draftState.dirty.value, false);
  const start = posted.length;
  return { models, view,
    writes: () => posted.slice(start).filter(message => message.type === 'modelProfile.scope.set'),
    ack(write, sequence) {
      const input = write.payload;
      const { inheritModel: _inheritModel, ...pinnedProfile } = profile;
      models.applyScopeSnapshot({ ...base, profileState: 'default', revision: String(sequence), sequence, outcome: 'committed',
        operation: input.operation, expectedRevision: input.expectedRevision,
        profile: { ...pinnedProfile, name: input.name, providerConfigId: input.providerConfigId, provider: input.provider, model: input.model },
        link: { ...link, updatedAt: sequence } }, write.id);
    },
    observe(read, sequence, saved = base) {
      models.applyScopeSnapshot({ ...saved, revision: String(sequence), sequence, outcome: 'observed',
        ...(read.payload.afterRequestId ? { afterRequestId: read.payload.afterRequestId } : {}) }, read.id);
    }
  };
}

test('model profile saving an edit back to its saved value becomes clean only after its correlated ACK', async t => {
  const { models, view, writes, ack } = confirmedModelFixture(t);
  view.model = 'B'; view.model = 'A';
  assert.equal(view.draftState.dirty.value, true, 'returning to the saved model is still an unacknowledged edit');
  view.save(); const write = writes()[0];
  assert.ok(write); assert.equal(write.payload.model, 'A'); assert.equal(write.payload.expectedRevision, '1');
  assert.equal(view.draftState.dirty.value, true);
  ack(write, 2); await vue.nextTick();
  assert.equal(models.confirmedFor('agent', 'agent').revision, '2');
  assert.equal(models.completedSaveFor('agent', 'agent'), write.id);
  assert.equal(models.pendingFor('agent', 'agent'), undefined);
  assert.equal(view.model, 'A'); assert.equal(view.draftState.dirty.value, false);
});

test('model profile queued saves acknowledge only their own draft revision', async t => {
  const { models, view, writes, ack } = confirmedModelFixture(t);
  view.model = 'B'; view.save(); const first = writes()[0];
  view.model = 'A'; view.save();
  assert.equal(writes().length, 1, 'the newer save waits for the in-flight request');
  assert.equal(models.pendingFor('agent', 'agent').queued, true);
  const reserved = models.pendingFor('agent', 'agent').submissionRequestId;
  assert.equal(typeof reserved, 'string'); assert.notEqual(reserved, first.id);
  ack(first, 2); await vue.nextTick();
  const second = writes()[1];
  assert.ok(second); assert.notEqual(second.id, first.id); assert.equal(second.id, reserved);
  assert.equal(second.payload.model, 'A'); assert.equal(second.payload.expectedRevision, '2');
  assert.equal(models.completedSaveFor('agent', 'agent'), first.id);
  assert.equal(models.pendingFor('agent', 'agent').requestId, second.id);
  assert.equal(view.model, 'A'); assert.equal(view.draftState.dirty.value, true, 'the older B ACK cannot acknowledge the newer A edit');
  ack(second, 3); await vue.nextTick();
  assert.equal(models.completedSaveFor('agent', 'agent'), second.id);
  assert.equal(models.pendingFor('agent', 'agent'), undefined);
  assert.equal(view.model, 'A'); assert.equal(view.draftState.dirty.value, false);
});

test('conversation model profile saving the confirmed effective model does not invent a save request or completion', t => {
  const { models, view, writes } = confirmedModelFixture(t, 'conversation');
  const completed = models.completedSaveFor('conversation', 'c');
  view.model = 'B'; view.model = 'A';
  assert.equal(view.draftState.dirty.value, true);
  const before = posted.length;
  view.save();
  assert.equal(posted.length, before, 'an authority-confirmed no-op must not send a read or write request');
  assert.equal(writes().length, 0); assert.equal(models.pendingFor('conversation', 'c'), undefined);
  assert.equal(models.completedSaveFor('conversation', 'c'), completed);
  assert.equal(view.model, 'A'); assert.equal(view.draftState.dirty.value, false);
});

for (const profileState of ['absent', 'inherit-model']) {
  test(`conversation model profile explicitly pins the inherited effective model (${profileState})`, async t => {
    const { models, view, writes, ack } = confirmedModelFixture(t, 'conversation', profileState);
    view.selectedProviderConfigId = 'provider'; view.model = 'A'; view.save();
    const write = writes()[0];
    assert.equal(writes().length, 1, 'selecting the inherited model must create an explicit scope override');
    assert.equal(write.payload.model, 'A'); assert.equal(write.payload.operation, 'select');
    assert.equal(view.providerConfigId, 'provider'); assert.equal(view.model, 'A');
    assert.equal(view.draftState.dirty.value, true);
    assert.equal(models.completedSaveFor('conversation', 'c'), undefined);
    ack(write, 2); await vue.nextTick();
    const saved = models.confirmedFor('conversation', 'c');
    assert.equal(saved.profileState, 'default'); assert.notEqual(saved.profile.inheritModel, true);
    assert.equal(saved.link.modelProfileId, saved.profile.id);
    assert.equal(saved.profile.model, 'A'); assert.equal(models.completedSaveFor('conversation', 'c'), write.id);
    assert.equal(view.providerConfigId, 'provider'); assert.equal(view.model, 'A');
    assert.equal(view.draftState.dirty.value, false);
  });
}

test('model store public discard API replaces a pre-write read with an exact after-write read', t => {
  const { models, view, writes, observe } = confirmedModelFixture(t);
  models.refreshScope('agent', 'agent'); const beforeWriteRead = posted.at(-1);
  assert.equal(beforeWriteRead.payload.afterRequestId, undefined);
  view.model = 'B'; view.save(); const write = writes()[0];
  // The save-status button is disabled while reading; this exercises the public store API only.
  const discarded = models.discardPending('agent', 'agent'), afterWriteRead = posted.at(-1);
  assert.notEqual(discarded, beforeWriteRead.id); assert.equal(discarded, afterWriteRead.id);
  assert.equal(afterWriteRead.payload.afterRequestId, write.id);
  observe(beforeWriteRead, 2);
  assert.equal(models.pendingFor('agent', 'agent').requestId, write.id);
  assert.equal(models.completedDiscardReadFor('agent', 'agent'), undefined);
  assert.equal(models.confirmedFor('agent', 'agent').revision, '1', 'the superseded response is ignored');
  observe(afterWriteRead, 3);
  assert.equal(models.pendingFor('agent', 'agent'), undefined);
  assert.equal(models.completedDiscardReadFor('agent', 'agent'), afterWriteRead.id);
  assert.equal(models.readingFor('agent', 'agent'), false); assert.equal(writes().length, 1);
});

for (const newerInput of [false, true]) {
  test(`model discard cancels the unsent queued selection when the in-flight write ACK arrives first${newerInput ? ' and preserves subsequent input' : ''}`, async t => {
    const { models, view, writes, ack, observe } = confirmedModelFixture(t);
    view.model = 'B'; view.save(); const write = writes()[0];
    view.model = 'A'; view.save();
    assert.equal(models.pendingFor('agent', 'agent').queued, true);
    assert.equal(models.readingFor('agent', 'agent'), false);
    view.discardDraft(); const read = posted.at(-1);
    assert.equal(read.payload.afterRequestId, write.id);
    if (newerInput) view.model = 'C';
    ack(write, 2); await vue.nextTick();
    assert.equal(writes().length, 1, 'discard must not send the queued A selection after the B ACK');
    assert.equal(models.completedSaveFor('agent', 'agent'), write.id);
    assert.equal(models.completedDiscardReadFor('agent', 'agent'), undefined);
    assert.equal(view.model, newerInput ? 'C' : 'A');
    observe(read, 3, models.confirmedFor('agent', 'agent')); await vue.nextTick();
    assert.equal(models.pendingFor('agent', 'agent'), undefined);
    assert.equal(models.completedDiscardReadFor('agent', 'agent'), read.id);
    assert.equal(view.model, newerInput ? 'C' : 'B');
    assert.equal(view.draftState.dirty.value, newerInput);
    assert.equal(writes().length, 1);
  });
}

for (const receiptOrder of ['ack-first', 'read-first']) {
  test(`model discard targets its original choice and preserves a later explicit Save (${receiptOrder})`, async t => {
    const { models, view, writes, ack, observe } = confirmedModelFixture(t);
    view.model = 'B'; view.save(); const first = writes()[0];
    view.model = 'A'; view.save();
    view.discardDraft(); const read = posted.at(-1);
    view.model = 'C'; view.save();
    const laterSubmission = models.pendingFor('agent', 'agent').submissionRequestId;
    assert.equal(models.pendingFor('agent', 'agent').queued, true);
    const saved = models.confirmedFor('agent', 'agent');
    const savedB = { ...saved, profile: { ...saved.profile, model: 'B' } };
    if (receiptOrder === 'ack-first') {
      ack(first, 2); await vue.nextTick();
      observe(read, 3, savedB);
    } else {
      observe(read, 2, savedB); await vue.nextTick();
      ack(first, 3);
    }
    await vue.nextTick();
    assert.deepEqual(writes().map(write => write.payload.model), ['B', 'C'], 'discard must not cancel a Save made after it');
    const second = writes()[1];
    assert.equal(second.id, laterSubmission); assert.equal(second.payload.expectedRevision, '2');
    assert.equal(models.pendingFor('agent', 'agent').requestId, second.id);
    assert.equal(models.pendingFor('agent', 'agent').status, 'saving');
    assert.equal(models.completedDiscardReadFor('agent', 'agent'), undefined);
    assert.equal(view.model, 'C'); assert.equal(view.draftState.dirty.value, true);
    ack(second, 4); await vue.nextTick();
    assert.equal(models.pendingFor('agent', 'agent'), undefined);
    assert.equal(models.confirmedFor('agent', 'agent').profile.model, 'C');
    assert.equal(view.model, 'C'); assert.equal(view.draftState.dirty.value, false);
  });
}

function startModelReconciliationRead(models) {
  const schedule = globalThis.setTimeout;
  let timeout, delay;
  try {
    globalThis.setTimeout = (callback, milliseconds) => { timeout = callback; delay = milliseconds; return 0; };
    models.refreshScope('agent', 'agent');
  } finally { globalThis.setTimeout = schedule; }
  assert.equal(delay, 10000);
  return { models, read: posted.at(-1), timeout };
}
function failModelReconciliationRead(reconciliation, failure) {
  const { models, read, timeout } = reconciliation;
  if (failure === 'timeout') timeout();
  else if (failure === 'bridge-error') models.rejectRequest(read.id, 'reconciliation read failed');
  else models.applyScopeSnapshot({ scopeKind: 'agent', scopeId: 'agent', authorityId: 'authority', sessionId: 'session',
    sequence: 0, revision: '', profileState: 'unknown', outcome: 'uncertain', error: 'reconciliation read failed' }, read.id);
}

for (const failure of ['timeout', 'bridge-error', 'uncertain-snapshot']) {
  for (const newerStatus of ['saving', 'uncertain']) {
    test(`model older after-read ${failure} preserves the newer ${newerStatus} write and its waiters`, async t => {
      const { models, view, writes, ack } = confirmedModelFixture(t);
      view.model = 'B'; view.save(); const first = writes()[0];
      const reconciliation = startModelReconciliationRead(models);
      view.model = 'C'; view.save(); ack(first, 2);
      const second = writes()[1];
      assert.ok(second); assert.equal(models.pendingFor('agent', 'agent').requestId, second.id);
      let outcome = 'pending';
      let waiting;
      if (newerStatus === 'uncertain') models.rejectPending(second.id, 'C-specific save failure');
      else waiting = models.awaitSavedForScope('agent', 'agent').then(() => { outcome = 'resolved'; }, () => { outcome = 'rejected'; });
      failModelReconciliationRead(reconciliation, failure); await vue.nextTick();
      const pending = models.pendingFor('agent', 'agent');
      assert.equal(pending.requestId, second.id); assert.equal(pending.status, newerStatus);
      assert.equal(pending.error, newerStatus === 'uncertain' ? 'C-specific save failure' : undefined);
      assert.equal(models.readingFor('agent', 'agent'), false);
      assert.match(models.scopeErrors[JSON.stringify({ scopeKind: 'agent', scopeId: 'agent' })], /读取未确认|reconciliation read failed/);
      assert.equal(outcome, 'pending', 'an old read failure must not reject the newer save waiter');
      ack(second, 3);
      if (waiting) { await waiting; assert.equal(outcome, 'resolved'); }
      assert.equal(models.pendingFor('agent', 'agent'), undefined);
    });
  }
  test(`model current exact after-read ${failure} still marks its own write uncertain`, async t => {
    const { models, view, writes } = confirmedModelFixture(t);
    view.model = 'B'; view.save(); const first = writes()[0];
    const reconciliation = startModelReconciliationRead(models);
    const waiting = models.awaitSavedForScope('agent', 'agent');
    failModelReconciliationRead(reconciliation, failure);
    await assert.rejects(waiting, /读取未确认|reconciliation read failed/);
    assert.equal(models.pendingFor('agent', 'agent').requestId, first.id);
    assert.equal(models.pendingFor('agent', 'agent').status, 'uncertain');
    assert.equal(models.readingFor('agent', 'agent'), false);
  });
}

function uncertainInheritedModelFixture(t) {
  const h = fixture(t), models = useProfiles(), global = useGlobal();
  global.llmProviderConfigs.configs = [{ id: 'provider', name: 'fixture', provider: 'openai', model: 'global-model' }];
  const key = JSON.stringify({ scopeKind: 'conversation', scopeId: 'c' });
  const saved = { scopeKind: 'conversation', scopeId: 'c', authorityId: 'authority', sessionId: 'session',
    revision: '1', profileState: 'absent', outcome: 'observed',
    effectiveModel: { providerConfigId: 'provider', provider: 'openai', model: 'global-model' } };
  models.authorityId = 'authority';
  models.observations[key] = { ...saved, sequence: 1 };
  const view = h.mount('ModelProfileScopeEditor');
  models.applyScopeSnapshot({ ...saved, sequence: 2 }, models.reads[key].requestId);
  assert.equal(models.reads[key], undefined, 'finish the activation read before saving or discarding');
  view.selectedProviderConfigId = 'provider'; view.model = 'submitted-model'; view.save();
  const submitted = models.pendingFor('conversation', 'c').requestId;
  models.rejectPending(submitted, '保存结果未确定，请重新读取。');
  assert.equal(models.pendingFor('conversation', 'c').status, 'uncertain');
  return { models, view, key,
    confirmDiscard() {
      const read = models.reads[key];
      assert.equal(read.afterRequestId, submitted, 'discard must read after the uncertain submission');
      models.applyScopeSnapshot({ ...saved, sequence: 3, afterRequestId: submitted }, read.requestId);
    },
    writeCount: () => posted.filter(message => message.type === 'modelProfile.scope.set' || message.type === 'modelProfile.scope.clear').length
  };
}

test('model discard restores inheritance only after the unchanged saved scope is confirmed', async t => {
  const { models, view, key, confirmDiscard, writeCount } = uncertainInheritedModelFixture(t);
  const writes = writeCount();
  view.discardDraft();
  assert.equal(view.providerConfigId, 'provider'); assert.equal(view.model, 'submitted-model');
  assert.equal(view.draftState.dirty.value, true, 'the draft remains until the discard read succeeds');
  confirmDiscard(); await vue.nextTick();
  assert.equal(models.reads[key], undefined); assert.equal(models.pendingFor('conversation', 'c'), undefined);
  assert.equal(models.confirmedFor('conversation', 'c').profileState, 'absent');
  assert.equal(view.providerConfigId, '__inherit_global_model__'); assert.equal(view.model, '');
  assert.equal(view.draftState.dirty.value, false); assert.equal(view.draftChangedRemotely, false);
  assert.equal(writeCount(), writes, 'discard reads saved state without issuing another model mutation');
});

test('model discard confirmation preserves an edit made while reading the unchanged saved scope', async t => {
  const { models, view, confirmDiscard, writeCount } = uncertainInheritedModelFixture(t);
  const writes = writeCount();
  view.discardDraft();
  assert.equal(view.providerConfigId, 'provider'); assert.equal(view.model, 'submitted-model');
  view.model = 'typed-during-discard';
  confirmDiscard(); await vue.nextTick();
  assert.equal(models.pendingFor('conversation', 'c'), undefined);
  assert.equal(models.confirmedFor('conversation', 'c').profileState, 'absent');
  assert.equal(view.providerConfigId, 'provider'); assert.equal(view.model, 'typed-during-discard');
  assert.equal(view.draftState.dirty.value, true);
  assert.equal(writeCount(), writes, 'preserving the newer local edit must not submit it');
});

test('initial global reads preserve an explicitly cleared UA and untouched remote fields through acknowledgement', async t => {
  const h = fixture(t), settings = useGlobal(), view = h.mount('OtherSettingsTab', {});
  const start = posted.length;
  settings.network.userAgent = 'typed before initial load';
  settings.network.userAgent = '';
  view.saveOtherSettings();
  const messages = () => posted.slice(start);
  const read = section => messages().find(message => message.type === 'settings.global.get' && message.payload.section === section);
  const writes = section => messages().filter(message => message.type === 'settings.global.update' && message.payload.section === section);
  const remoteCommon = { ...JSON.parse(JSON.stringify(settings.common)), proxy: 'remote-proxy',
    proxyShellAndMcp: true, activeDataRootPath: '/fixture/remote-root' };
  settings.applySnapshot({ section: 'common', settings: remoteCommon, filePath: 'fixture', revision: 'initial-common' }, read('common').id);
  settings.applySnapshot({ section: 'network', settings: { userAgent: 'remote-UA' }, filePath: 'fixture', revision: 'initial-network' }, read('network').id);
  await vue.nextTick();
  assert.equal(settings.network.userAgent, '', 'the local clear must not be mistaken for an untouched initial default');
  assert.equal(writes('network')[0].payload.settings.userAgent, '', 'the explicit clear is what gets saved');
  assert.equal(settings.common.proxy, 'remote-proxy', 'unmodified fields still come from the first remote snapshot');
  assert.equal(settings.common.proxyShellAndMcp, true);
  assert.equal(settings.common.activeDataRootPath, '/fixture/remote-root');
  assert.equal(writes('common')[0].payload.settings.proxy, 'remote-proxy');
  assert.equal(writes('common')[0].payload.settings.proxyShellAndMcp, true);
  assert.equal(settings.baselines.network.userAgent, 'remote-UA', 'the saved baseline remains distinct until the write is acknowledged');
  for (const section of ['common', 'network']) {
    const write = writes(section)[0];
    settings.applySnapshot({ section, settings: write.payload.settings, filePath: 'fixture', revision: `saved-${section}` }, write.id);
  }
  await vue.nextTick();
  assert.equal(settings.network.userAgent, '');
  assert.equal(settings.baselines.network.userAgent, '');
  assert.equal(writes('common').length, 1);
  assert.equal(writes('network').length, 1, 'normal confirmation does not revive the removed UA');
  assert.equal(settings.executionSaveState(['common', 'network']), 'clean');
});

test('initial common read preserves a local toggle back to default without overwriting its untouched proxy', t => {
  fixture(t); const settings = useGlobal(), start = posted.length;
  settings.common.proxyShellAndMcp = true;
  settings.common.proxyShellAndMcp = false;
  settings.saveCommon();
  const messages = () => posted.slice(start);
  const read = messages().find(message => message.type === 'settings.global.get' && message.payload.section === 'common');
  const remote = { ...JSON.parse(JSON.stringify(settings.common)), proxy: 'remote-proxy', proxyShellAndMcp: true };
  settings.applySnapshot({ section: 'common', settings: remote, filePath: 'fixture', revision: 'initial-common-toggle' }, read.id);
  const write = messages().find(message => message.type === 'settings.global.update' && message.payload.section === 'common');
  assert.equal(settings.common.proxyShellAndMcp, false);
  assert.equal(settings.common.proxy, 'remote-proxy');
  assert.equal(write.payload.settings.proxyShellAndMcp, false);
  assert.equal(write.payload.settings.proxy, 'remote-proxy');
  settings.applySnapshot({ section: 'common', settings: write.payload.settings, filePath: 'fixture', revision: 'saved-common-toggle' }, write.id);
  assert.equal(settings.executionSaveState(['common']), 'clean');
});

for (const remotePresent of [false, true]) {
  test(`channel initial read preserves a queued new channel${remotePresent ? ' and the existing remote channel' : ''}`, async t => {
    const h = fixture(t), settings = useGlobal(), view = h.mount('ChannelSettingsTab', {});
    const start = posted.length;
    settings.applySnapshot({ section: 'llm', settings: { activeProviderConfigId: remotePresent ? 'remote-provider' : '' },
      filePath: 'fixture', revision: 'initial-llm' });
    view.openCreate(); view.confirmCreate('new local channel');
    const created = settings.llmProviderConfigs.configs[0], createdId = created.id;
    const remote = remotePresent ? [{ ...JSON.parse(JSON.stringify(created)), id: 'remote-provider', name: 'existing remote channel' }] : [];
    const initial = { section: 'llmProviderConfigs', settings: { configs: remote }, filePath: 'fixture', revision: 'initial-configs' };
    const messages = () => posted.slice(start);
    const writes = section => messages().filter(message => message.type === 'settings.global.update' && message.payload.section === section);
    const read = messages().find(message => message.type === 'settings.global.get' && message.payload.section === 'llmProviderConfigs');
    assert.ok(read, 'creating a channel before loading must acquire a saved revision first');
    assert.equal(writes('llmProviderConfigs').length, 0);
    settings.applySnapshot(initial, read.id); await vue.nextTick();
    const expectedIds = [createdId, ...(remotePresent ? ['remote-provider'] : [])].sort();
    assert.deepEqual(settings.llmProviderConfigs.configs.map(config => config.id).sort(), expectedIds);
    const write = writes('llmProviderConfigs')[0];
    assert.deepEqual(write.payload.settings.configs.map(config => config.id).sort(), expectedIds);
    settings.applySnapshot({ ...initial, settings: write.payload.settings, revision: 'saved-configs' }, write.id);
    const selection = writes('llm')[0];
    assert.ok(selection, 'activate the new channel only after its configuration is committed');
    settings.applySnapshot({ section: 'llm', settings: selection.payload.settings, filePath: 'fixture', revision: 'saved-llm' }, selection.id);
    await vue.nextTick();
    assert.equal(writes('llmProviderConfigs').length, 1, 'normal acknowledgements must not trigger a compensating deletion');
    assert.deepEqual(settings.llmProviderConfigs.configs.map(config => config.id).sort(), expectedIds);
    assert.deepEqual(settings.baselines.llmProviderConfigs.configs.map(config => config.id).sort(), expectedIds);
    assert.equal(settings.llm.activeProviderConfigId, createdId);
    assert.equal(settings.failedSettingsSections.llmProviderConfigs, undefined);
  });
}

const snapshot = (conversationId, name) => ({ conversationId, section: 'common', settings: { conversationId, name }, filePath: '' });
test('conversation explicit reload preserves an edit that returns to its original draft text', t => {
  const h = fixture(t), settings = useConversation(), view = h.mount('ConversationSettingsPanel', {});
  settings.request('c'); settings.applySnapshot(snapshot('c', 'A'), posted.at(-1).id);
  settings.common.name = 'B'; view.reload(); const read = posted.at(-1).id;
  settings.common.name = 'C'; settings.common.name = 'B';
  settings.applySnapshot(snapshot('c', 'A'), read);
  assert.equal(settings.common.name, 'B'); assert.equal(settings.savedName, 'A');
  assert.equal(settings.pendingReload, undefined);
  view.reload(); settings.applySnapshot(snapshot('c', 'A'), posted.at(-1).id);
  assert.equal(settings.common.name, 'A', 'a subsequent read with no intervening edit may discard the draft');
  settings.common.name = 'B'; view.reload(); const changedRead = posted.at(-1).id;
  settings.common.name = 'A'; settings.applySnapshot(snapshot('c', 'C'), changedRead);
  assert.equal(settings.common.name, 'A', 'editing back to the saved baseline still fences a pending explicit read');
  assert.equal(settings.savedName, 'C');
});

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
