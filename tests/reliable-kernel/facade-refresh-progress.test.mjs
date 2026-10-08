import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { createRequire } from 'node:module';
import test from 'node:test';

const compiled = path.resolve(process.env.LIMCODE_TEST_EXTENSION_ROOT ?? 'dist/extension',
  'backend/application/reliableKernel/VscodeReliableKernelApplicationFacade.js');
const require = createRequire(compiled);
const attention = require('./interactionAttention.js');
const { BridgeMessageType } = require('../../../shared/protocol.js');
const flush = async () => { for (let i = 0; i < 20; i++) await Promise.resolve(); };
function fixture({ historyDelay = 0, attentionDelay = 0, attentionFailureAt = 0 } = {}) {
  let now = 0, id = 0, hold = false;
  let activeHistoryReads = 0, maximumActiveHistoryReads = 0;
  let activeAttentionReads = 0, maximumActiveAttentionReads = 0;
  const timers = new Map(), historyReads = [], attentionReads = [], historyEvents = [], attentionEvents = [], pending = [];
  const conversations = new Map([['existing', { id: 'existing', title: 'Before' }]]), owners = new Set();
  const schedule = (fn, delay) => { const key = ++id; timers.set(key, { fn, at: now + delay }); return key; };
  const read = async (kind) => {
    (kind === 'history' ? historyReads : attentionReads).push(now);
    // A read freezes its snapshot before any command which may arrive while I/O is outstanding.
    const result = kind === 'history' ? { entries: [...conversations.values()].map(row => ({ ...row })), originLinks: [] } : [];
    const fail = kind === 'attention' && attentionReads.length === attentionFailureAt;
    if (kind === 'history') maximumActiveHistoryReads = Math.max(maximumActiveHistoryReads, ++activeHistoryReads);
    else maximumActiveAttentionReads = Math.max(maximumActiveAttentionReads, ++activeAttentionReads);
    try {
      if (hold) await new Promise((resolve) => pending.push(resolve));
      if (kind === 'history' && historyDelay) await new Promise(resolve => schedule(resolve, historyDelay));
      if (kind === 'attention' && attentionDelay) await new Promise(resolve => schedule(resolve, attentionDelay));
      if (fail) throw new Error('attention read failed');
      return result;
    } finally {
      if (kind === 'history') activeHistoryReads--;
      else activeAttentionReads--;
    }
  };
  const exports = {};
  const load = vm.runInThisContext(`(function(exports, require, setTimeout, clearTimeout) {${fs.readFileSync(compiled, 'utf8')}\n})`, { filename: compiled });
  load(exports, (name) => {
    if (name === 'node:crypto') return crypto;
    if (name === '../../../shared/protocol' || name === '../../../shared/plainData') return require(name);
    if (name === '../../../shared/conversationTitle') return require(name);
    if (name === './conversationHistoryProjection' || name === '../../capabilities/boundedConcurrency') return require(name);
    if (name === '../../reliableKernel/conversationContextHandleState') return require(name);
    if (name === './interactionAttention') return { ...attention, readPendingInteractionAttention: () => read('attention') };
    if (name === './VscodeReliableKernelCommandRouter') return { watchConversationRefresh: () => () => {} };
    if (name.endsWith('/repositories')) return { DOMAIN_REPOSITORIES: { domain: domain => ({
      insert: row => ({ domain, operation: 'insert', row }), update: (id, patch) => ({ domain, operation: 'update', id, patch })
    }) } };
    return {};
  }, schedule, (key) => timers.delete(key));
  // Exercise the real facade methods with its I/O boundaries replaced, without opening a Runtime.
  const facade = Object.create(exports.VscodeReliableKernelApplicationFacade.prototype);
  Object.assign(facade, {
    disposed: false, productClosing: false, productClosed: false, historyRefreshPending: undefined, interactionAttentionRefreshPending: undefined,
    commandRouter: { beginClose() {}, detachClient() {} },
    interactionLeaseEdges: { observe: () => false },
    interactionAttentionNotifier: { synchronize: () => attentionEvents.push(now), clear() {} },
    product: { configuration: { resolveAgent: async () => ({ agentId: 'agent' }) }, application: { database: {
      hostBootId: 'host',
      transaction: async steps => {
        for (const step of steps.filter(step => step.domain === 'Conversation')) {
          if (step.operation === 'insert') conversations.set(step.row.id, { ...step.row });
          else conversations.set(step.id, { ...conversations.get(step.id), ...step.patch });
        }
        facade.onRuntimeCommit({ changes: steps.map(step => ({ domain: step.domain })) });
      },
      conversationOwners: { run: async (conversationId, operation) => {
        assert.ok(!owners.has(conversationId)); owners.add(conversationId);
        try { return await operation(); } finally { owners.delete(conversationId); }
      } }
    } }, close: async () => {} },
    resolveProjectFolderForNewConversation: () => undefined,
    maybeRow: async (_domain, conversationId) => conversations.get(conversationId) ?? null,
    queryConversationHistoryPage: () => read('history'),
    historyEmitter: { fire: () => historyEvents.push(now), dispose() {} }, historyRevealEmitter: { fire() {}, dispose() {} },
    externalHistoryWatcher: { start: async () => {}, cancel() {} }, webviews: new Map(), webviewConversationIds: new Map()
  });
  return { facade, timers, historyReads, attentionReads, historyEvents, attentionEvents, owners,
    maximumActiveHistoryReads: () => maximumActiveHistoryReads,
    maximumActiveAttentionReads: () => maximumActiveAttentionReads,
    commit(domain = 'Message') { facade.onRuntimeCommit({ changes: [{ domain, kind: 'upsert', id: 'id', record: {} }] }); },
    hold() { hold = true; }, release() { hold = false; for (const resolve of pending.splice(0)) resolve(); },
    async advance(ms) {
      const end = now + ms;
      while (true) {
        const next = [...timers].filter(([, item]) => item.at <= end).sort((a, b) => a[1].at - b[1].at)[0];
        if (!next) break;
        now = next[1].at; timers.delete(next[0]); next[1].fn(); await flush();
      }
      now = end; await flush();
    }
  };
}

test('同一消息同时生成历史标题和预览时只读取、解析一次正文', async (context) => {
  const h = fixture(); context.after(() => h.facade.dispose());
  h.facade.historyPreviewByRevisionId = new Map();
  h.facade.historyTitleByRevisionId = new Map();
  const body = JSON.stringify({ role: 'user', parts: [{ text: '同一份消息正文' }] });
  let reads = 0, parses = 0;
  h.facade.product.application.contentStore = { async read() { reads++; return Buffer.from(body); } };
  const parse = JSON.parse;
  context.mock.method(JSON, 'parse', (source, ...args) => { if (source === body) parses++; return parse(source, ...args); });
  const target = { conversationId: 'conversation', revisionId: 'revision', content: { content_type: 'application/vnd.limcode.message+json' } };
  const result = await h.facade.readConversationHistoryProjectionContent([target], [target]);
  assert.equal(result.titles.get('conversation'), '同一份消息正文');
  assert.equal(result.previews.get('conversation'), '同一份消息正文');
  assert.equal(reads, 1);
  assert.equal(parses, 1);
  await h.facade.readConversationHistoryProjectionContent([target], [target]);
  assert.equal(reads, 1, 'both derived values share the same cached read');
});

function commandRoutingFixture() {
  const h = fixture();
  const replies = [], writes = [], controls = [], warnings = [];
  let profileCaptures = 0, catalogReads = 0, reconnects = 0, delivered = true;
  const file = path.join(path.dirname(compiled), 'VscodeReliableKernelCommandRouter.js');
  const exports = {};
  const load = vm.runInThisContext(`(function(exports, require, console) {${fs.readFileSync(file, 'utf8')}\n})`, { filename: file });
  load(exports, (name) => {
    if (name === 'node:crypto') return crypto;
    if (name === '../../../shared/protocol' || name === '../../../shared/plainData') return require(name);
    if (name === 'vscode') return { window: { showWarningMessage: message => warnings.push(message) } };
    return {};
  }, { error() {}, warn() {} });
  const router = Object.create(exports.VscodeReliableKernelCommandRouter.prototype);
  const product = h.facade.product;
  product.configuration.mutations = {
    updateAgent: async payload => writes.push({ type: 'agent', payload }),
    captureModelProfileRoot: () => { profileCaptures++; throw new Error('unexpected profile authority capture'); }
  };
  product.application.webviewFeed = { detach() {}, reconnect() { reconnects++; } };
  Object.assign(router, {
    product, options: {}, closing: false, configurationMutationQueue: Promise.resolve(), clientIdByWebview: new WeakMap(),
    settingsSaveBarrier: { detach() {}, observe: (...args) => controls.push(['activity', ...args]), receive: (...args) => controls.push(['flush', ...args]) },
    updateGlobalSettings: async (_webview, payload) => writes.push({ type: 'global', payload }),
    broadcastConfigurationSnapshot: async () => { catalogReads++; },
    postConfigurationSnapshot: async () => { catalogReads++; }
  });
  const webview = { postMessage: async reply => { replies.push(reply); return delivered; } };
  h.facade.commandRouter = router;
  h.facade.webviews.set('settings-client', webview);
  return { ...h, replies, writes, controls, warnings,
    profileCaptures: () => profileCaptures, catalogReads: () => catalogReads, reconnects: () => reconnects,
    delivery(value) { delivered = value; },
    message(type, payload, id = type) { h.facade.handleWebviewMessage('settings-client', { id, type, payload, channel: 'command' }); }
  };
}

test('open Facade still routes global settings and Agent updates through the real Router', async (t) => {
  const h = commandRoutingFixture(); t.after(() => h.facade.dispose());
  h.message(BridgeMessageType.GlobalSettingsUpdate, { section: 'llm', settings: {}, expectedRevision: 'before' });
  h.message(BridgeMessageType.AgentUpdate, { agentId: 'agent', name: 'After' });
  await flush();
  assert.deepEqual(h.writes.map(write => write.type), ['global', 'agent']);
});

for (const phase of ['in-flight', 'failed']) {
  test(`closing ${phase} Facade rejects business messages with correlated typed results and never reaches writers`, async (t) => {
    const h = commandRoutingFixture();
    let failClose;
    h.facade.product.close = () => new Promise((_, reject) => { failClose = reject; });
    const closing = assert.rejects(h.facade.closeProduct(), { code: 'EACCES' });
    t.after(async () => {
      failClose(Object.assign(new Error('owner cleanup failed'), { code: 'EACCES' })); await closing;
      h.facade.product.close = async () => {}; await h.facade.dispose();
    });
    if (phase === 'failed') {
      failClose(Object.assign(new Error('owner cleanup failed'), { code: 'EACCES' })); await closing;
    }
    h.message(BridgeMessageType.GlobalSettingsUpdate, { section: 'llm', settings: {}, expectedRevision: 'before' }, 'global-save');
    h.message(BridgeMessageType.AgentUpdate, { agentId: 'agent', name: 'After' }, 'agent-save');
    h.message(BridgeMessageType.ModelProfileScopeSet, { scopeKind: 'conversation', scopeId: 'conversation', authorityId: 'authority', sessionId: 'profile-session', expectedRevision: 'before' }, 'profile-save');
    h.message(BridgeMessageType.Ready, { settingsActivitySessionId: 'session' }, 'ready');
    h.message(BridgeMessageType.ClientResync, { conversationId: 'conversation' }, 'resync');
    for (const type of [BridgeMessageType.TurnStart, BridgeMessageType.TurnEnqueue]) {
      h.message(type, { conversationId: 'conversation', command: { commandId: `command-${type}` }, text: 'retained draft' }, type);
    }
    h.message(BridgeMessageType.TurnSteer, { conversationId: 'conversation', command: { commandId: 'steer-command' } }, 'steer');
    for (const type of [BridgeMessageType.GuidanceEdit, BridgeMessageType.GuidanceCancel, BridgeMessageType.GuidanceHold, BridgeMessageType.GuidanceReorder]) {
      h.message(type, { conversationId: 'conversation', command: { commandId: `command-${type}` }, intentId: 'intent', items: [] }, type);
    }
    h.message(BridgeMessageType.AttachmentOpen, { attachmentId: 'attachment', data: 'must-not-echo', name: 'file' }, 'attachment-open');
    h.message(BridgeMessageType.AttachmentReload, { attachmentId: 'attachment', name: 'file' }, 'attachment-reload');
    h.message(BridgeMessageType.CheckpointShadowStatsGet, undefined, 'checkpoint-stats');
    h.message(BridgeMessageType.CheckpointRestore, { checkpointId: 'checkpoint', conversationId: 'conversation' }, 'checkpoint-restore');
    await flush();
    assert.deepEqual(h.writes, []);
    assert.equal(h.profileCaptures(), 0, 'early ModelProfile routing cannot capture retired authority');
    assert.equal(h.catalogReads(), 0, 'rejection must not request a fresh configuration snapshot');
    assert.equal(h.reconnects(), 0);
    const reply = id => h.replies.find(message => message.correlationId === id);
    assert.equal(reply('global-save').type, BridgeMessageType.Error);
    assert.deepEqual(reply('global-save').scope, { kind: 'settings', level: 'global', id: 'llm' });
    assert.equal(reply('global-save').payload.requestType, BridgeMessageType.GlobalSettingsUpdate);
    assert.match(reply('global-save').payload.message, /已关闭/);
    assert.equal(reply('agent-save').payload.requestType, BridgeMessageType.AgentUpdate);
    assert.equal(reply('profile-save').type, BridgeMessageType.ModelProfileScopeSnapshot);
    assert.equal(reply('profile-save').payload.authorityId, 'authority');
    assert.equal(reply('profile-save').payload.sessionId, 'profile-session');
    assert.match(reply('profile-save').payload.error, /已关闭/);
    assert.equal(reply('ready').type, BridgeMessageType.Error);
    assert.equal(reply('resync').type, BridgeMessageType.Error);
    for (const type of [BridgeMessageType.TurnStart, BridgeMessageType.TurnEnqueue]) {
      assert.equal(reply(type).type, BridgeMessageType.TurnInputResult);
      assert.deepEqual(reply(type).payload, { commandId: `command-${type}`, conversationId: 'conversation', requestType: type,
        status: 'rejected', admitted: false, deduplicated: false, message: '可靠 ApplicationFacade 已关闭。' });
    }
    assert.equal(reply('steer').type, BridgeMessageType.TurnSteerResult);
    assert.equal(reply('steer').payload.commandId, 'steer-command');
    const guidance = [BridgeMessageType.GuidanceEdit, BridgeMessageType.GuidanceCancel, BridgeMessageType.GuidanceHold, BridgeMessageType.GuidanceReorder];
    for (const type of guidance) {
      assert.equal(reply(type).type, BridgeMessageType.GuidanceControlResult);
      assert.equal(reply(type).payload.commandId, `command-${type}`);
      assert.equal(reply(type).payload.action, type.split('.').at(-1));
      assert.equal(reply(type).payload.status, 'rejected');
    }
    assert.equal(reply('attachment-open').type, BridgeMessageType.AttachmentOpenResult);
    assert.equal(reply('attachment-reload').type, BridgeMessageType.AttachmentReloadResult);
    assert.equal(reply('attachment-open').payload.status, 'failed');
    assert.equal(reply('attachment-reload').payload.status, 'failed');
    assert.ok(!('data' in reply('attachment-open').payload.request));
    assert.equal(reply('checkpoint-stats').type, BridgeMessageType.CheckpointShadowStatsSnapshot);
    assert.equal(reply('checkpoint-restore').payload.result.status, 'failed');
  });
}

test('closing Facade keeps save-barrier acknowledgements and Ping, but rejected delivery never reconnects', async (t) => {
  const h = commandRoutingFixture(); t.after(() => h.facade.dispose());
  await h.facade.closeProduct();
  h.message(BridgeMessageType.Ping, { text: 'ping', sentAt: 1 }, 'ping');
  h.message(BridgeMessageType.GlobalSettingsActivity, { sessionId: 'session' }, 'activity');
  h.message(BridgeMessageType.GlobalSettingsFlushResult, { status: 'failed', activity: {}, message: 'closing' }, 'flush');
  await flush();
  assert.equal(h.replies.find(reply => reply.correlationId === 'ping').type, BridgeMessageType.Pong);
  assert.deepEqual(h.controls.map(item => item[0]), ['activity', 'flush']);
  assert.deepEqual(h.writes, []);
  h.delivery(false);
  h.message(BridgeMessageType.AgentUpdate, { agentId: 'agent', name: 'After' }, 'undelivered');
  await flush();
  assert.equal(h.reconnects(), 0);
  assert.equal(h.catalogReads(), 0);
});

for (const leadingAttention of [false, true]) {
  test(`hydration ${leadingAttention ? 'joins an existing attention read' : 'starts its attention read'} and lets rename finish during continuous updates`, async (t) => {
    const h = fixture({ attentionDelay: 100 });
    t.after(async () => { await h.facade.dispose(); h.release(); await h.advance(1000); });
    let hydrated = false, renamed = false, error;
    if (leadingAttention) void h.facade.refreshInteractionAttention();
    // Sidebar rename and opening a chat both await this same public hydration boundary.
    const command = h.facade.waitUntilHydrated().then(() => {
      hydrated = true;
      return h.facade.renameConversationTitleNow('existing', 'After');
    });
    void command.then(() => { renamed = true; }, failure => { error = failure; });
    await flush();
    for (let i = 0; i < 100; i++) {
      h.commit('InteractionRequest'); await h.advance(10);
      if (i === 8) {
        assert.equal(hydrated, false, 'hydration must wait for its first attention snapshot');
        assert.equal(h.facade.historyEntries[0].title, 'Before');
      }
      if (i === (leadingAttention ? 21 : 11)) {
        assert.equal(error, undefined);
        assert.equal(hydrated, true, 'future attention updates must not extend hydration');
        assert.equal(renamed, true);
        assert.equal(h.owners.size, 0);
        assert.equal(h.facade.historyEntries[0].title, 'After');
      }
    }
    await command;
    assert.equal(h.maximumActiveAttentionReads(), 1);
    assert.ok(h.attentionEvents.length >= 10, 'notifications must continue after hydration and the command finish');
  });
}

for (const attentionFailureAt of [1, 2]) {
  test(`attention read ${attentionFailureAt} failure reaches only its own callers and permits later refresh`, async (t) => {
    const h = fixture({ attentionFailureAt }); h.hold();
    t.after(() => h.facade.dispose());
    const first = h.facade.refreshInteractionAttention(), next = h.facade.refreshInteractionAttention();
    const observed = [attentionFailureAt === 1 ? assert.rejects(first, /attention read failed/) : first,
      attentionFailureAt === 2 ? assert.rejects(next, /attention read failed/) : next];
    h.release(); await Promise.all(observed);
    assert.equal(h.attentionReads.length, 2); assert.equal(h.attentionEvents.length, 1);
    await h.facade.refreshInteractionAttention();
    assert.equal(h.attentionEvents.length, 2);
    assert.equal(h.maximumActiveAttentionReads(), 1);
  });
}

test('facade disposal settles queued refresh callers without starting or publishing another read', async () => {
  const h = fixture(); h.hold();
  const history = h.facade.refreshConversationHistory(), nextHistory = h.facade.refreshConversationHistory();
  const attention = h.facade.refreshInteractionAttention(), nextAttention = h.facade.refreshInteractionAttention();
  await h.facade.dispose(); h.release();
  await Promise.all([history, nextHistory, attention, nextAttention]);
  assert.equal(h.historyReads.length, 1); assert.equal(h.attentionReads.length, 1);
  assert.equal(h.historyEvents.length, 0); assert.equal(h.attentionEvents.length, 0);
  assert.equal(h.timers.size, 0);
});

test('closing with a failed attention read rejects that read and settles queued callers without another read', async () => {
  const h = fixture({ attentionFailureAt: 1 }); h.hold();
  const current = assert.rejects(h.facade.refreshInteractionAttention(), /attention read failed/);
  const next = h.facade.refreshInteractionAttention();
  await h.facade.dispose(); h.release();
  await Promise.all([current, next]);
  assert.equal(h.attentionReads.length, 1); assert.equal(h.attentionEvents.length, 0);
  assert.equal(h.timers.size, 0);
});

test('facade closeRuntime keeps views retired but retries failed product cleanup with one attempt at a time', async (t) => {
  const h = fixture();
  let closeCalls = 0, releaseFailure;
  const retired = { history: 0, reveal: 0, attention: 0, watcher: 0, commit: 0, steering: 0 };
  h.facade.historyEmitter.dispose = () => retired.history++;
  h.facade.historyRevealEmitter.dispose = () => retired.reveal++;
  h.facade.interactionAttentionNotifier.clear = () => retired.attention++;
  h.facade.externalHistoryWatcher.cancel = () => retired.watcher++;
  h.facade.unsubscribeCommit = () => retired.commit++;
  h.facade.unsubscribeSteering = () => retired.steering++;
  h.facade.product.close = () => {
    closeCalls++;
    return closeCalls === 1 ? new Promise((_, reject) => { releaseFailure = reject; }) : Promise.resolve();
  };
  const observe = promise => promise.then(() => ({ success: true }), error => ({ error }));
  const first = observe(h.facade.closeRuntime()), concurrent = observe(h.facade.closeRuntime());
  t.after(async () => {
    releaseFailure(Object.assign(new Error('owner cleanup failed'), { code: 'EACCES' }));
    await Promise.all([first, concurrent]);
    await h.facade.closeRuntime();
  });
  assert.equal(closeCalls, 1);
  assert.equal(h.facade.disposed, true);
  assert.equal(h.facade.productClosed, false, 'an unfinished attempt cannot declare the Runtime closed');
  await assert.rejects(h.facade.createConversationNow({}), /已关闭/);
  releaseFailure(Object.assign(new Error('owner cleanup failed'), { code: 'EACCES' }));
  const outcomes = await Promise.all([first, concurrent]);
  assert.ok(outcomes.every(result => result.error?.code === 'EACCES'), 'all callers must observe the failed cleanup');
  assert.equal(h.facade.productClosed, false);
  await h.facade.closeRuntime();
  assert.equal(closeCalls, 2, 'a later close must actually retry cleanup');
  assert.equal(h.facade.productClosed, true);
  await h.facade.closeRuntime();
  assert.equal(closeCalls, 2);
  assert.deepEqual(retired, { history: 1, reveal: 1, attention: 1, watcher: 1, commit: 1, steering: 1 });
  h.commit(); h.commit('InteractionRequest');
  await h.facade.refreshConversationHistory(); await h.facade.refreshInteractionAttention();
  assert.equal(h.historyReads.length, 0); assert.equal(h.attentionReads.length, 0);
  assert.equal(h.timers.size, 0);
});

test('product cleanup retires business commands before view disposal and never restores them after failure', async (t) => {
  const h = fixture();
  let closeCalls = 0, fail;
  h.facade.product.close = () => {
    closeCalls++;
    return closeCalls === 1 ? new Promise((_, reject) => { fail = reject; }) : Promise.resolve();
  };
  // Development reset closes the product before disposing its shell. It must fence commands now.
  const attempt = h.facade.closeProduct();
  const observed = assert.rejects(attempt, { code: 'EACCES' });
  t.after(async () => {
    fail(Object.assign(new Error('owner cleanup failed'), { code: 'EACCES' }));
    await observed; await h.facade.closeRuntime();
  });
  assert.equal(h.facade.disposed, false);
  assert.equal(h.facade.productClosed, false);
  await assert.rejects(h.facade.createConversationNow({}), /已关闭/);
  fail(Object.assign(new Error('owner cleanup failed'), { code: 'EACCES' }));
  await observed;
  await assert.rejects(h.facade.createConversationNow({}), /已关闭/);
  assert.equal(h.owners.size, 0);
  await h.facade.closeRuntime();
  assert.equal(closeCalls, 2);
  assert.equal(h.facade.productClosed, true);
  await assert.rejects(h.facade.createConversationNow({}), /已关闭/);
});

for (const action of ['create', 'rename']) {
  test(`facade ${action} returns and releases its owner during continuous slow history refreshes`, async (t) => {
    const h = fixture({ historyDelay: 100 });
    t.after(async () => { await h.facade.dispose(); h.release(); await h.advance(1000); });
    // The command must wait for a fresh pass: the first snapshot predates its committed change.
    let firstDone = false;
    void h.facade.refreshConversationHistory().then(() => { firstDone = true; });
    await flush();
    let done = false, result, error;
    const command = action === 'create'
      ? h.facade.createConversationNow({})
      : h.facade.renameConversationTitleNow('existing', 'After');
    void command.then(value => { done = true; result = value; }, failure => { done = true; error = failure; });
    await flush();
    assert.equal(h.owners.size, 1);
    for (let i = 0; i < 100; i++) {
      h.commit(); await h.advance(10);
      if (i === 9) {
        assert.equal(firstDone, true, 'an earlier caller only waits for its own pass');
        assert.equal(done, false, 'the snapshot before the command cannot complete its refresh');
        assert.equal(h.owners.size, 1);
      }
      if (i === 21) {
        assert.equal(error, undefined);
        assert.equal(done, true, 'the command must finish without waiting for the event stream to stop');
        assert.equal(h.owners.size, 0);
        assert.ok(h.facade.historyEntries.some(row => action === 'create' ? row.id === result : row.id === 'existing' && row.title === 'After'));
      }
    }
    await command;
    assert.equal(h.maximumActiveHistoryReads(), 1);
    assert.ok(h.historyEvents.length >= 10, 'background refreshes must continue after the command returns');
  });
}
test('facade history and interaction refreshes make progress throughout continuous relevant commits', async () => {
  const h = fixture();
  for (let i = 0; i < 500; i++) { h.commit(); h.commit('InteractionRequest'); await h.advance(10); }
  assert.equal(h.historyReads[0], 25);
  assert.equal(h.attentionReads[0], 25);
  assert.ok(h.historyReads.length >= 166);
  assert.ok(h.attentionReads.length >= 166);
  assert.equal(h.historyEvents.length, h.historyReads.length);
  assert.equal(h.attentionEvents.length, h.attentionReads.length);
  await h.advance(25);
  const counts = [h.historyReads.length, h.attentionReads.length];
  await h.advance(1000);
  assert.deepEqual([h.historyReads.length, h.attentionReads.length], counts);
  await h.facade.dispose();
});
test('slow facade reads coalesce dirty edges and publish one trailing state without overlap', async () => {
  const h = fixture(); h.hold(); h.commit(); h.commit('InteractionRequest'); await h.advance(25);
  for (let i = 0; i < 50; i++) { h.commit(); h.commit('InteractionRequest'); await h.advance(10); }
  await h.advance(25);
  assert.equal(h.historyReads.length, 1); assert.equal(h.attentionReads.length, 1);
  h.release(); await flush();
  assert.equal(h.historyReads.length, 2); assert.equal(h.attentionReads.length, 2);
  assert.equal(h.historyEvents.length, 2); assert.equal(h.attentionEvents.length, 2);
  await h.facade.dispose();
});
test('facade disposal cancels pending deadlines and ignores late reads', async () => {
  const h = fixture(); h.hold(); h.commit(); h.commit('InteractionRequest'); await h.advance(25);
  h.commit(); h.commit('InteractionRequest'); await h.facade.dispose(); h.release(); await flush();
  assert.equal(h.historyEvents.length, 0); assert.equal(h.attentionEvents.length, 0);
  await h.advance(1000);
  h.commit(); h.commit('InteractionRequest');
  await h.facade.refreshConversationHistory(); await h.facade.refreshInteractionAttention();
  assert.equal(h.timers.size, 0);
  assert.equal(h.historyReads.length, 1); assert.equal(h.attentionReads.length, 1);
});
