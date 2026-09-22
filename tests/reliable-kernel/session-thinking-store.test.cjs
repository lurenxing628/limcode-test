const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const test = require('node:test');
const ts = require('typescript');
const pinia = require('pinia');
const vue = require('vue');
const protocol = require('../../dist/extension/shared/protocol.js');
const { createEmptyClientState } = require('../../dist/extension/shared/clientStateSchema.js');

function fixture() {
  pinia.setActivePinia(pinia.createPinia());
  const requests = [], timers = [], listeners = new Map();
  const bridge = { request(type, payload) { const id = `request-${requests.length}`; requests.push({ id, type, payload: structuredClone(payload) }); return id; },
    on(type, callback) { listeners.set(type, callback); return () => listeners.delete(type); }, ready() {}, currentClientId() { return 'fixture-client'; } };
  let client, store;
  const noopStore = new Proxy({ records: {}, viewKind: 'test' }, { get(target, key) { return key in target ? target[key] : () => undefined; } });
  function load(file) {
    const code = ts.transpileModule(fs.readFileSync(file, 'utf8'), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText;
    const module = { exports: {} };
    vm.runInNewContext(code, { exports: module.exports, module, console, setTimeout: callback => timers.push(callback), require(name) {
      if (name === 'pinia') return pinia;
      if (name === 'vue') return { ...vue, onBeforeUnmount() {}, watch() { return () => undefined; } };
      if (name === '@shared/protocol') return protocol;
      if (name === '@shared/clientStateSchema') return { createEmptyClientState };
      if (name.endsWith('/useClientStateStore') || name === './useClientStateStore') return { useClientStateStore: () => client };
      if (name.endsWith('/useModelProfileStore')) return { useModelProfileStore: () => store };
      if (name === '@webview/transport') return { BridgeMessageType: protocol.BridgeMessageType, bridge };
      if (name.startsWith('@webview/stores/')) return { [name.split('/').at(-1)]: () => noopStore };
      throw new Error(`Unexpected dependency: ${name}`);
    } });
    return module.exports;
  }
  client = load('webview/src/stores/useClientStateStore.ts').useClientStateStore();
  store = load('webview/src/stores/useModelProfileStore.ts').useModelProfileStore();
  load('webview/src/composables/useBridgeBootstrap.ts').useBridgeBootstrap();
  const emit = (type, payload, correlationId, clientId) => listeners.get(type)?.({ payload, correlationId, clientId });
  const reply = (request, payload) => emit(protocol.BridgeMessageType.ModelProfileScopeSnapshot,
    payload.outcome === 'committed' ? { operation: request.type === protocol.BridgeMessageType.ModelProfileScopeClear ? 'clear' : request.payload.operation, expectedRevision: request.payload.expectedRevision, ...payload } : payload, request.id);
  const read = (scopeId, payload = snapshot(scopeId, 'low', 1)) => { store.refreshScope('conversation', scopeId); reply(requests.at(-1), payload); };
  return { store, client, requests, timers, emit, reply, read };
}
const model = { providerConfigId: 'fixture', provider: 'openai-compatible', model: 'o3' };
function snapshot(scopeId, value, sequence, authorityId = 'root-a') {
  const profile = value === null ? undefined : { id: `profile-${scopeId}`, name: 'fixture', ...model, ...(value ? { thinkingOverride: { kind: 'openai-effort', value } } : {}) };
  return { scopeKind: 'conversation', scopeId, authorityId, sessionId: `session-${scopeId}-${authorityId}`, sequence, revision: `etag-${scopeId}-${sequence}`, outcome: 'observed', effectiveModel: model,
    profileState: !profile ? 'absent' : profile.thinkingOverride ? 'overridden' : 'default',
    ...(profile ? { profile, link: { id: `link-${scopeId}`, scopeKind: 'conversation', scopeId, modelProfileId: profile.id, role: 'active', createdAt: 1, updatedAt: sequence } } : {}) };
}
const choose = (f, scope, value) => f.store.setThinkingForScope(scope, vue.reactive(model), vue.reactive({ kind: 'openai-effort', value }));

test('失效编辑会话的重读失败后显式重连，解除发送等待且不重放旧写入', async () => {
  const f = fixture(); f.read('a'); choose(f, 'a', 'high');
  const write = f.requests.at(-1);
  f.store.rejectPending(write.id, 'connection lost');
  f.store.retryPending('conversation', 'a');
  f.reply(f.requests.at(-1), { ...snapshot('a', undefined, 2), outcome: 'uncertain', revision: '', error: 'expired session' });
  f.store.retryPending('conversation', 'a');
  const recovery = f.requests.at(-1);
  assert.equal(recovery.payload.renewSession, true);
  assert.equal(recovery.payload.afterRequestId, undefined);
  f.reply(recovery, { ...snapshot('a', 'low', 3), sessionId: 'renewed' });
  await f.store.awaitSavedForScope('conversation', 'a');
  assert.equal(f.store.pendingFor('conversation', 'a'), undefined);
  assert.equal(f.store.detachedFor('conversation', 'a').profile.thinkingOverride.value, 'high');
  f.reply(write, { ...snapshot('a', 'high', 99), outcome: 'committed' });
  assert.equal(f.store.thinkingFor('conversation', 'a').value, 'low');
  assert.equal(f.requests.filter(r => r.type === protocol.BridgeMessageType.ModelProfileScopeSet).length, 1);
});

test('transport读取错误立即结束loading，并允许取得新的scope版本', () => {
  const f = fixture(); f.store.activateScope('conversation', 'a');
  const read = f.requests.at(-1);
  f.emit(protocol.BridgeMessageType.Error, { requestType: read.type, message: 'read failed' }, read.id);
  assert.equal(f.store.readingFor('conversation', 'a'), false);
  assert.equal(f.store.errorFor('conversation', 'a'), 'read failed');
  f.read('a');
  assert.equal(f.store.errorFor('conversation', 'a'), '');
});

test('首次读取失败时保留的模型选择也能通过显式重连解除发送等待', async () => {
  const f = fixture();
  f.store.setProfileForScope('conversation', 'a', model);
  const read = f.requests.at(-1);
  f.emit(protocol.BridgeMessageType.Error, { requestType: read.type, message: 'initial read failed' }, read.id);
  f.store.retryPending('conversation', 'a');
  f.reply(f.requests.at(-1), snapshot('a', null, 1));
  await f.store.awaitSavedForScope('conversation', 'a');
  assert.equal(f.store.pendingFor('conversation', 'a'), undefined);
  assert.ok(f.store.detachedFor('conversation', 'a'));
  assert.equal(f.requests.filter(r => r.type === protocol.BridgeMessageType.ModelProfileScopeSet).length, 0);
});

test('Hello更换host后重新读取，旧保存不能恢复旧scope或阻塞发送', async () => {
  const f = fixture();
  f.emit(protocol.BridgeMessageType.Hello, {}, undefined, 'host-a');
  f.store.activateScope('conversation', 'a'); f.reply(f.requests.at(-1), snapshot('a', 'low', 1));
  choose(f, 'a', 'high'); const old = f.requests.at(-1);
  const waiting = assert.rejects(f.store.awaitSavedForScope('conversation', 'a'), /连接已更换/);
  f.emit(protocol.BridgeMessageType.Hello, {}, undefined, 'host-b');
  await waiting;
  const fresh = f.requests.at(-1);
  assert.equal(fresh.type, protocol.BridgeMessageType.ModelProfileScopeRead);
  assert.equal(fresh.payload.sessionId, undefined);
  f.reply(fresh, snapshot('a', 'medium', 1, 'root-b'));
  f.reply(old, { ...snapshot('a', 'high', 100), outcome: 'committed' });
  await f.store.awaitSavedForScope('conversation', 'a');
  assert.equal(f.store.thinkingFor('conversation', 'a').value, 'medium');
});

test('上级模型变化后不展示旧模型的思维覆盖', () => {
  const f = fixture(); const observed = snapshot('a', 'high', 1);
  observed.profile.inheritModel = true;
  observed.effectiveModel = { ...model, model: 'new-model' };
  f.read('a', observed);
  assert.equal(f.store.thinkingFor('conversation', 'a'), undefined);
});

test('真实bootstrap full payload迟到不覆盖已确认scope；只触发受控读并接受外部更新', () => {
  const f = fixture(); f.store.activateScope('conversation', 'a'); f.reply(f.requests.at(-1), snapshot('a', 'low', 1));
  choose(f, 'a', 'high'); const write = f.requests.at(-1);
  f.reply(write, { ...snapshot('a', 'high', 3), outcome: 'committed' });
  const old = snapshot('a', 'low', 1);
  f.emit(protocol.BridgeMessageType.ConfigurationSnapshot, { state: { ...createEmptyClientState(), modelProfiles: [old.profile], modelProfileScopeLinks: [old.link] } }, 'unrelated-old');
  assert.equal(f.client.modelProfiles[0].thinkingOverride.value, 'high');
  assert.equal(f.store.confirmedFor('conversation', 'a').profile.thinkingOverride.value, 'high');
  const refresh = f.requests.at(-1); assert.equal(refresh.type, protocol.BridgeMessageType.ModelProfileScopeRead);
  f.reply(refresh, snapshot('a', 'medium', 4));
  assert.equal(f.store.confirmedFor('conversation', 'a').profile.thinkingOverride.value, 'medium');
  const count = f.requests.length;
  f.emit(protocol.BridgeMessageType.ConfigurationSnapshot, { state: { ...createEmptyClientState(), modelProfiles: [old.profile], modelProfileScopeLinks: [old.link] } });
  assert.equal(f.requests.length, count, 'unchanged catalogs cannot create read loops');
});

test('scope序号独立、absence受保护，迟到scoped与陌生host payload不倒退', () => {
  const f = fixture(); f.read('a', snapshot('a', 'high', 10)); f.read('b', snapshot('b', 'low', 20));
  f.store.refreshScope('conversation', 'a'); const a = f.requests.at(-1); f.reply(a, snapshot('a', null, 11));
  assert.equal(f.store.confirmedFor('conversation', 'a').profile, undefined);
  f.reply(a, snapshot('a', 'low', 9));
  assert.equal(f.store.confirmedFor('conversation', 'a').profile, undefined);
  f.store.refreshScope('conversation', 'a'); const second = f.requests.at(-1); f.reply(second, snapshot('a', 'low', 30, 'retired-root'));
  assert.equal(f.store.confirmedFor('conversation', 'a').profile, undefined);
});

test('timeout只scope-local保留不确定；放弃必须after原请求且绝不补偿write', async () => {
  const f = fixture(); f.read('a'); choose(f, 'a', 'high'); const write = f.requests.at(-1);
  f.timers.at(-1)();
  await assert.rejects(f.store.awaitSavedForScope('conversation', 'a'), /未确定/);
  await f.store.awaitSavedForScope('conversation', 'b');
  f.store.discardPending('conversation', 'a'); const read = f.requests.at(-1);
  assert.equal(read.type, protocol.BridgeMessageType.ModelProfileScopeRead);
  assert.equal(read.payload.afterRequestId, write.id);
  f.reply(read, { ...snapshot('a', 'low', 2), outcome: 'uncertain', revision: '', error: 'still pending' });
  assert.ok(f.store.pendingFor('conversation', 'a'));
  f.store.discardPending('conversation', 'a'); const settled = f.requests.at(-1);
  f.reply(settled, { ...snapshot('a', 'high', 3), afterRequestId: write.id });
  assert.equal(f.store.pendingFor('conversation', 'a'), undefined);
  assert.equal(f.store.confirmedFor('conversation', 'a').profile.thinkingOverride.value, 'high');
  assert.equal(f.requests.filter(r => r.type === protocol.BridgeMessageType.ModelProfileScopeSet).length, 1, 'no compensation writes');
});

test('快速high→medium→reset只顺序提交最新草稿，用每次实际ack revision，不泄漏Proxy', async () => {
  const f = fixture(); f.read('a'); choose(f, 'a', 'high'); const first = f.requests.at(-1);
  choose(f, 'a', 'medium'); f.store.setThinkingForScope('a', model, null);
  assert.equal(f.requests.at(-1).id, first.id);
  f.reply(first, { ...snapshot('a', 'high', 2), outcome: 'committed' });
  const reset = f.requests.at(-1);
  assert.equal(reset.payload.operation, 'reset'); assert.equal(reset.payload.expectedRevision, 'etag-a-2');
  f.reply(first, { ...snapshot('a', 'high', 2), outcome: 'committed' });
  assert.equal(f.store.pendingFor('conversation', 'a').requestId, reset.id);
  f.reply(reset, { ...snapshot('a', undefined, 3), outcome: 'committed' });
  await f.store.awaitSavedForScope('conversation', 'a');
  assert.equal(f.store.confirmedFor('conversation', 'a').profile.model, model.model, 'reset of explicit selection preserves model');
  assert.equal(f.store.confirmedFor('conversation', 'a').profile.thinkingOverride, undefined);
});

test('无thinking模型失败/超时保留局部错误；实际值重读不自动重发', () => {
  const f = fixture(); f.read('a');
  f.store.setProfileForScope('conversation', 'a', { ...model, model: 'gpt-4o' }); const write = f.requests.at(-1);
  f.reply(write, { ...snapshot('a', 'low', 1), outcome: 'uncertain', revision: '', error: 'synthetic save failure' });
  assert.equal(f.store.pendingFor('conversation', 'a').profile.model, 'gpt-4o');
  f.store.retryPending('conversation', 'a'); const read = f.requests.at(-1);
  assert.equal(read.payload.afterRequestId, write.id);
  f.reply(read, { ...snapshot('a', 'high', 2), afterRequestId: write.id });
  assert.equal(f.store.pendingFor('conversation', 'a').status, 'draft');
  assert.equal(f.requests.filter(r => r.type === protocol.BridgeMessageType.ModelProfileScopeSet).length, 1);
  const source = fs.readFileSync('webview/src/components/input/Composer.vue', 'utf8');
  assert.doesNotMatch(source, /ModelProfileSaveStatus|放弃草稿|重新读取/);
});

test('显式同root重建scope会话隔离未知旧操作，保留草稿且不永久锁发送', async () => {
  const f = fixture(); f.read('a'); choose(f, 'a', 'high'); const old = f.requests.at(-1);
  f.store.rejectPending(old.id, 'unknown request');
  f.store.refreshScope('conversation', 'a', { adoptRoot: true }); const refresh = f.requests.at(-1);
  assert.equal(refresh.payload.renewSession, true);
  f.reply(refresh, { ...snapshot('a', 'low', 2), sessionId: 'renewed-session' });
  assert.equal(f.store.pendingFor('conversation', 'a'), undefined);
  assert.equal(f.store.detachedFor('conversation', 'a').profile.thinkingOverride.value, 'high');
  await f.store.awaitSavedForScope('conversation', 'a');
  f.reply(old, { ...snapshot('a', 'high', 99), outcome: 'committed' });
  assert.equal(f.store.confirmedFor('conversation', 'a').profile.thinkingOverride.value, 'low');
  assert.equal(f.requests.filter(r => r.type === protocol.BridgeMessageType.ModelProfileScopeSet).length, 1);
});

test('显式新root基线保留旧草稿但不跨代提交；晚old ack/Hello/Error不恢复旧scope', () => {
  const f = fixture(); f.read('a'); choose(f, 'a', 'high'); const oldWrite = f.requests.at(-1);
  f.store.rejectPending(oldWrite.id, 'host restarted');
  f.store.refreshScope('conversation', 'a', { adoptRoot: true }); const adoption = f.requests.at(-1);
  f.reply(adoption, snapshot('a', null, 1, 'root-b'));
  assert.equal(f.store.authorityId, 'root-b'); assert.ok(f.store.detachedFor('conversation', 'a'));
  assert.equal(f.store.pendingFor('conversation', 'a'), undefined);
  f.reply(oldWrite, { ...snapshot('a', 'high', 99), outcome: 'committed' });
  f.store.rejectPending(oldWrite.id, 'late old error');
  assert.equal(f.store.confirmedFor('conversation', 'a').authorityId, 'root-b');
  assert.equal(f.requests.filter(r => r.type === protocol.BridgeMessageType.ModelProfileScopeSet).length, 1);
});


test('review scope after-read of previous request cannot detach newer queued write', async () => {
  const f = fixture(); f.read('a'); choose(f, 'a', 'high'); const high = f.requests.at(-1);
  f.store.refreshScope('conversation', 'a'); const readHigh = f.requests.at(-1);
  choose(f, 'a', 'medium');
  f.reply(high, { ...snapshot('a', 'high', 3), outcome: 'committed' }); const medium = f.requests.at(-1);
  assert.equal(medium.payload.thinkingOverride.value, 'medium');
  const waiting = f.store.awaitSavedForScope('conversation', 'a');
  f.reply(readHigh, { ...snapshot('a', 'high', 4), afterRequestId: high.id });
  assert.equal(f.store.pendingFor('conversation', 'a').requestId, medium.id);
  assert.equal(f.store.pendingFor('conversation', 'a').status, 'saving');
  f.reply(medium, { ...snapshot('a', 'medium', 5), outcome: 'committed' }); await waiting;
  assert.equal(f.store.pendingFor('conversation', 'a'), undefined);
});

for (const invalid of ['missing-operation', 'wrong-operation', 'wrong-baseline', 'unknown-absence', 'dangling-link']) test(`review scope clear receipt rejects unverified operation/baseline/absence: ${invalid}`, () => {
  const f = fixture(); f.read('a'); f.store.clearProfileScope('conversation', 'a'); const request = f.requests.at(-1);
  const payload = { ...snapshot('a', null, 2), outcome: 'committed', operation: 'clear', expectedRevision: request.payload.expectedRevision, profileState: 'absent' };
  if (invalid === 'missing-operation') delete payload.operation;
  if (invalid === 'wrong-operation') payload.operation = 'reset';
  if (invalid === 'wrong-baseline') payload.expectedRevision = 'unrelated-etag';
  if (invalid === 'unknown-absence') payload.profileState = 'unknown';
  if (invalid === 'dangling-link') payload.link = snapshot('a', 'high', 1).link;
  f.emit(protocol.BridgeMessageType.ModelProfileScopeSnapshot, payload, request.id);
  assert.equal(f.store.pendingFor('conversation', 'a')?.status, 'uncertain');
  assert.equal(f.store.confirmedFor('conversation', 'a').profile.thinkingOverride.value, 'low', 'malformed confirmation cannot clear saved observation');
});

for (const changed of ['session', 'authority']) test(`review scope delayed clear from old ${changed} cannot confirm switched Gemini selection`, async () => {
  const f = fixture(); f.read('a'); f.store.clearProfileScope('conversation', 'a'); const clear = f.requests.at(-1);
  f.store.refreshScope('conversation', 'a', { adoptRoot: true }); const read = f.requests.at(-1);
  const root = changed === 'authority' ? 'root-b' : 'root-a';
  const fresh = { ...snapshot('a', null, 2, root), sessionId: 'new-session', profileState: 'absent' };
  f.reply(read, fresh);
  const target = { providerConfigId: 'gemini-channel', provider: 'gemini', model: 'gemini-2.5-flash' };
  f.store.setProfileForScope('conversation', 'a', target); const select = f.requests.at(-1);
  const late = { ...snapshot('a', null, 99), outcome: 'committed', operation: 'clear', profileState: 'absent', expectedRevision: clear.payload.expectedRevision };
  f.emit(protocol.BridgeMessageType.ModelProfileScopeSnapshot, late, clear.id);
  assert.equal(f.store.pendingFor('conversation', 'a').requestId, select.id);
  assert.equal(f.store.confirmedFor('conversation', 'a').sessionId, 'new-session');
  const selected = snapshot('a', 'high', 3, root); delete selected.profile.thinkingOverride; Object.assign(selected.profile, target);
  f.reply(select, { ...selected, effectiveModel: target, sessionId: 'new-session', profileState: 'default', outcome: 'committed', operation: 'select', expectedRevision: select.payload.expectedRevision });
  await f.store.awaitSavedForScope('conversation', 'a');
  f.emit(protocol.BridgeMessageType.ModelProfileScopeSnapshot, late, clear.id);
  assert.equal(f.store.confirmedFor('conversation', 'a').profile.providerConfigId, target.providerConfigId);
});

function composerSubmit(f) {
  const source = fs.readFileSync('webview/src/components/input/Composer.vue', 'utf8').match(/<script setup lang="ts">([\s\S]*?)<\/script>/)[1];
  const ast = ts.createSourceFile('Composer.ts', source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  const names = ['savingSessionSelections', 'savingSessionSelection', 'conversationInputDisabled'];
  const parts = ast.statements.filter(statement => ts.isFunctionDeclaration(statement) ? statement.name?.text === 'submit'
    : ts.isVariableStatement(statement) && statement.declarationList.declarations.some(item => names.includes(item.name.getText(ast))));
  assert.equal(parts.length, 4, 'execute production submit and its actual scoped guard declarations');
  const code = parts.map(statement => statement.getText(ast)).join('\n') + '\nmodule.exports = { submit, savingSessionSelection };';
  const module = { exports: {} }, sent = [];
  vm.runInNewContext(ts.transpileModule(code, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS } }).outputText, {
    module, ref: vue.ref, computed: vue.computed, clientState: f.client, modelProfileStore: f.store, props: { disabled: false },
    currentSubmissionCommandId: vue.ref(), currentSteeringSubmitting: vue.ref(false), draft: vue.ref('synthetic message'), selectedAttachments: vue.ref([]),
    buildMessageContent: text => ({ text }), ui: { isEditing: false }, nativeSteeringAvailable: vue.ref(false),
    currentTurnAuthoritySelection: () => ({}), sendMessage: (text, content) => { sent.push({ conversationId: f.client.currentConversationId, text, content }); }
  });
  return { ...module.exports, sent };
}

test('review scope production Composer submit waits only origin conversation; navigation and failure remain visible', async () => {
  const f = fixture(); f.read('a'); f.read('b');
  f.client.currentConversationId = 'a'; choose(f, 'a', 'high'); const write = f.requests.at(-1);
  const composer = composerSubmit(f);
  const waitingA = composer.submit(); assert.equal(composer.savingSessionSelection.value, true);
  f.client.currentConversationId = 'b'; assert.equal(composer.savingSessionSelection.value, false);
  await composer.submit(); assert.equal(composer.sent[0].conversationId, 'b');
  f.reply(write, { ...snapshot('a', 'high', 3), outcome: 'committed' }); await waitingA;
  assert.equal(composer.sent.length, 1, 'old await cannot send into new conversation');
  f.client.currentConversationId = 'a';
  f.store.setProfileForScope('conversation', 'a', { ...model, model: 'gpt-4o' });
  const failed = f.requests.at(-1); f.store.rejectPending(failed.id, 'synthetic non-thinking save failed');
  await composer.submit();
  assert.match(f.store.errorFor('conversation', 'a'), /save failed/);
  assert.equal(composer.sent.length, 1);
  assert.equal(f.store.pendingFor('conversation', 'a').profile.model, 'gpt-4o');
  const template = fs.readFileSync('webview/src/components/input/Composer.vue', 'utf8');
  assert.doesNotMatch(template, /ModelProfileSaveStatus|放弃草稿|重新读取/);
  assert.match(template, /:model="confirmedEffectiveModel\?\.model"/);
});


test('sessionless broadcasts invalidate only active same-authority newer scope; never acknowledge a write', () => {
  const f = fixture(); f.store.activateScope('conversation', 'a'); f.reply(f.requests.at(-1), snapshot('a', 'low', 1));
  choose(f, 'a', 'high'); const pending = f.store.pendingFor('conversation', 'a');
  const peer = { ...snapshot('a', 'medium', 2), outcome: 'committed' }; delete peer.sessionId;
  f.emit(protocol.BridgeMessageType.ModelProfileScopeSnapshot, peer);
  assert.equal(f.store.errorFor('conversation', 'a'), '');
  assert.equal(f.store.confirmedFor('conversation', 'a').profile.thinkingOverride.value, 'low', 'invalidation is not a replacement for locked observation');
  assert.equal(f.store.pendingFor('conversation', 'a').requestId, pending.requestId);
  assert.equal(f.store.pendingFor('conversation', 'a').status, 'saving');
  assert.equal(f.store.readingFor('conversation', 'a'), true, 'peer update schedules one guarded read');
  const count = f.requests.length;
  f.emit(protocol.BridgeMessageType.ModelProfileScopeSnapshot, peer);
  f.emit(protocol.BridgeMessageType.ModelProfileScopeSnapshot, { ...peer, authorityId: 'foreign', sequence: 99 });
  f.emit(protocol.BridgeMessageType.ModelProfileScopeSnapshot, { ...peer, scopeId: 'inactive', sequence: 99 });
  assert.equal(f.requests.length, count);
});

test('inherit receipt validates explicit boolean and preserves current thinking', () => {
  const f = fixture(); f.read('a');
  f.store.setChildThinkingInheritance('a', model, true); const request = f.requests.at(-1);
  assert.deepEqual(JSON.parse(JSON.stringify(f.store.thinkingFor('conversation', 'a'))), { kind: 'openai-effort', value: 'low' });
  const ack = { ...snapshot('a', 'low', 2), outcome: 'committed' };
  ack.profile.inheritThinkingToChildren = true;
  f.reply(request, ack);
  assert.equal(f.store.pendingFor('conversation', 'a'), undefined);
  assert.equal(f.store.childThinkingInheritanceFor('conversation', 'a'), true);
});
