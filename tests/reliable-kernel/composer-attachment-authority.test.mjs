import assert from 'node:assert/strict';
import { before, after, test } from 'node:test';
import { createWebviewSsrServer } from './webview-ssr-server.mjs';

let server, vue, pinia, Composer, useClient, useUi, useProfiles, useFeed, protocol;
const posted = [], readers = [];
const hostListeners = new Set();
const previousWindow = globalThis.window, previousFileReader = globalThis.FileReader;
before(async () => {
  globalThis.window = {
    addEventListener(type, listener) { if (type === 'message') hostListeners.add(listener); },
    removeEventListener(type, listener) { if (type === 'message') hostListeners.delete(listener); },
    setTimeout() { return 0; }, clearTimeout() {},
    acquireVsCodeApi() { return { postMessage(message) { posted.push(message); }, getState() {}, setState() {} }; }
  };
  globalThis.FileReader = class {
    readAsDataURL(file) { this.file = file; readers.push(this); }
    finish() { this.result = `data:${this.file.type};base64,YXR0YWNobWVudA==`; this.onload(); }
  };
  server = await createWebviewSsrServer();
  vue = await import('vue'); pinia = await import('pinia');
  ({ useClientStateStore: useClient } = await server.ssrLoadModule('/src/stores/useClientStateStore.ts'));
  ({ useConversationUiStore: useUi } = await server.ssrLoadModule('/src/stores/useConversationUiStore.ts'));
  ({ useModelProfileStore: useProfiles } = await server.ssrLoadModule('/src/stores/useModelProfileStore.ts'));
  ({ useReliableKernelClientFeedStore: useFeed } = await server.ssrLoadModule('/src/stores/useReliableKernelClientFeedStore.ts'));
  ({ BridgeMessageType: protocol } = await server.ssrLoadModule('/@fs' + process.cwd() + '/shared/protocol.ts'));
  Composer = (await server.ssrLoadModule('/src/components/input/Composer.vue')).default;
});
after(async () => {
  await server?.close(); globalThis.window = previousWindow; globalThis.FileReader = previousFileReader;
});

function fixture(t) {
  const stores = pinia.createPinia(); pinia.setActivePinia(stores);
  const client = useClient(), ui = useUi(), profiles = useProfiles(), feed = useFeed();
  const id = `conversation-${posted.length}`;
  client.currentConversationId = id;
  feed.projections = { activeConversationWindow: { conversationId: id } };
  // Scope I/O is the controlled external boundary; use the actual stores and SFC watchers.
  profiles.activateScope = () => () => {};
  profiles.awaitSavedForScope = async () => {};
  const timers = [], originalSetTimeout = globalThis.setTimeout;
  globalThis.setTimeout = (...args) => { const timer = originalSetTimeout(...args); timers.push(timer); return timer; };
  const renderer = vue.createRenderer({ createElement: () => ({}), createText: () => ({}), createComment: () => ({}),
    setText() {}, setElementText() {}, parentNode() { return null; }, nextSibling() { return null; },
    insert() {}, remove() {}, patchProp() {} });
  // Only DOM rendering is replaced. setup, lifecycle hooks, Pinia and Vue scheduling are real.
  const app = renderer.createApp({ ...Composer, render() { return null; }, ssrRender: undefined }).use(stores);
  app.provide(vue.ssrContextKey, { modules: new Set() });
  const view = app.mount({}).$.setupState;
  const start = posted.length;
  t.after(() => {
    app.unmount(); pinia.disposePinia(stores);
    for (const timer of timers) clearTimeout(timer);
    globalThis.setTimeout = originalSetTimeout;
  });
  return {
    client, ui, profiles, view,
    sent: () => posted.slice(start).filter(message => message.type === protocol.TurnStart || message.type === protocol.TurnEnqueue),
    acknowledge(message) {
      for (const listener of hostListeners) listener({ data: {
        id: 'fixture-ack', type: protocol.TurnInputResult, correlationId: message.id,
        payload: { commandId: message.payload.command.commandId, conversationId: message.payload.conversationId,
          requestType: message.type, status: 'accepted', admitted: true, deduplicated: false }
      } });
    },
    read(name = 'attachment.txt') {
      const pending = view.onPasteFiles([{ name, type: 'text/plain', size: 10 }]);
      const reader = readers.at(-1);
      return { pending, finish: () => reader.finish() };
    }
  };
}

function message(id) {
  return { id, conversationId: 'c', content: { role: 'user', parts: [{ text: `text-${id}` }] } };
}

for (const replacement of ['other message', 'same message reopened', 'queued input']) {
  test(`FileReader cannot attach into a replacement edit: ${replacement}`, async t => {
    const h = fixture(t), original = message('A');
    h.ui.startEditMessage(original, 1); await vue.nextTick();
    const read = h.read('for-A.txt');
    h.ui.cancelEditMode();
    if (replacement === 'queued input') h.ui.startEditTurnIntent({ intentId: 'intent-B', rowVersion: 1 }, 'text-B');
    else h.ui.startEditMessage(replacement === 'other message' ? message('B') : original, 1);
    await vue.nextTick(); read.finish(); await read.pending;
    assert.deepEqual(h.view.selectedAttachments, []);
    assert.deepEqual(h.view.attachmentSnapshots.chat, []);
  });
}

for (const mode of ['chat', 'edit']) {
  test(`FileReader is invalid after a conversation switches away and back in ${mode} mode`, async t => {
    const h = fixture(t);
    if (mode === 'edit') { h.ui.startEditMessage(message('A'), 1); await vue.nextTick(); }
    const read = h.read(), origin = h.client.currentConversationId;
    h.client.currentConversationId = 'another-conversation'; h.client.currentConversationId = origin;
    read.finish(); await read.pending;
    assert.deepEqual(h.view.selectedAttachments, []);
  });
}

for (const finishDuringEdit of [true, false]) {
  test(`a chat FileReader retains its chat bucket through an edit; finishes ${finishDuringEdit ? 'during' : 'after'} edit`, async t => {
    const h = fixture(t), read = h.read('for-chat.txt');
    h.ui.startEditMessage(message('A'), 1); await vue.nextTick();
    if (!finishDuringEdit) { h.ui.cancelEditMode(); await vue.nextTick(); }
    read.finish(); await read.pending;
    if (finishDuringEdit) {
      assert.deepEqual(h.view.selectedAttachments, []);
      assert.equal(h.view.attachmentSnapshots.chat[0].inlineData.name, 'for-chat.txt');
      h.ui.cancelEditMode(); await vue.nextTick();
    }
    assert.equal(h.view.selectedAttachments[0].inlineData.name, 'for-chat.txt');
  });
}

test('an attachment read in the same edit session is accepted', async t => {
  const h = fixture(t); h.ui.startEditMessage(message('A'), 1); await vue.nextTick();
  const read = h.read('for-A.txt'); read.finish(); await read.pending;
  assert.equal(h.view.selectedAttachments[0].inlineData.name, 'for-A.txt');
});

for (const change of ['remove attachment', 'attachment ABA', 'text ABA', 'conversation ABA', 'edit mode ABA']) {
  test(`waiting for model settings cannot submit a superseded draft: ${change}`, async t => {
    const h = fixture(t), read = h.read('removed.txt'); read.finish(); await read.pending;
    h.ui.setComposerDraft('original text');
    let release;
    h.profiles.awaitSavedForScope = () => new Promise(resolve => { release = resolve; });
    const waiting = h.view.submit();
    assert.equal(h.view.savingSessionSelection, true);
    if (change === 'remove attachment' || change === 'attachment ABA') {
      const part = h.view.selectedAttachments[0]; h.view.removeAttachment(0);
      if (change === 'attachment ABA') h.view.selectedAttachments.push(part);
    } else if (change === 'text ABA') {
      h.ui.setComposerDraft('newer text'); h.ui.setComposerDraft('original text');
    } else if (change === 'conversation ABA') {
      const origin = h.client.currentConversationId;
      h.client.currentConversationId = 'other'; h.client.currentConversationId = origin;
    } else {
      h.ui.startEditMessage(message('A'), 1); h.ui.cancelEditMode();
    }
    release(); await waiting;
    assert.equal(h.view.savingSessionSelection, false);
    assert.deepEqual(h.sent(), []);
    assert.equal(h.ui.chatDraft, 'original text');
  });
}

test('an unchanged draft sends its attachment after model settings finish saving', async t => {
  const h = fixture(t), read = h.read('send.txt'); read.finish(); await read.pending;
  h.ui.setComposerDraft('send text');
  let release;
  h.profiles.awaitSavedForScope = () => new Promise(resolve => { release = resolve; });
  const waiting = h.view.submit(); assert.deepEqual(h.sent(), []);
  release(); await waiting;
  assert.equal(h.sent().length, 1);
  assert.equal(h.sent()[0].payload.text, 'send text');
  assert.equal(h.sent()[0].payload.content.parts[1].inlineData.name, 'send.txt');
});

test('an old FileReader cannot append to a confirmed send-as-new replacement draft', async t => {
  const h = fixture(t); h.ui.setComposerDraft('old unsent draft');
  const read = h.read('old-draft.txt'), replacement = message('replacement');
  replacement.content.parts.push({ inlineData: { mimeType: 'text/plain', name: 'replacement.txt',
    storage: 'embedded', status: 'available', data: 'cmVwbGFjZW1lbnQ=', sizeBytes: 11 } });
  h.ui.prefillChatDraft(replacement); await vue.nextTick();
  assert.ok(h.view.chatDraftPrefill.pending.value);
  h.view.chatDraftPrefill.confirm(); await vue.nextTick();
  read.finish(); await read.pending;
  assert.equal(h.ui.chatDraft, 'text-replacement');
  assert.deepEqual(h.view.attachmentSnapshots.chat.map(part => part.inlineData.name), ['replacement.txt']);
});

test('replacing a chat draft with identical text also invalidates its old FileReader', async t => {
  const h = fixture(t); h.ui.setComposerDraft('same text');
  const read = h.read('old-draft.txt'); h.ui.replaceChatDraft('same text');
  read.finish(); await read.pending;
  assert.equal(h.ui.chatDraft, 'same text'); assert.deepEqual(h.view.selectedAttachments, []);
});

for (const text of ['sent text', '']) {
  test(`a successful send starts a new draft and rejects an earlier FileReader (${text ? 'text' : 'attachments only'})`, async t => {
    const h = fixture(t);
    if (!text) { const attachment = h.read('sent.txt'); attachment.finish(); await attachment.pending; }
    h.ui.setComposerDraft(text);
    const read = h.read('old-draft.txt'); await h.view.submit();
    assert.equal(h.sent().length, 1);
    h.acknowledge(h.sent()[0]); await vue.nextTick();
    assert.equal(h.ui.chatDraft, ''); assert.deepEqual(h.view.selectedAttachments, []);
    assert.equal(h.view.currentSubmissionCommandId, undefined);
    h.ui.setComposerDraft('next draft'); read.finish(); await read.pending;
    assert.equal(h.ui.chatDraft, 'next draft'); assert.deepEqual(h.view.selectedAttachments, []);
  });
}

test('ordinary typing keeps the current chat FileReader valid', async t => {
  const h = fixture(t); h.ui.setComposerDraft('first words');
  const read = h.read('same-draft.txt'); h.ui.setComposerDraft('more words in this draft');
  read.finish(); await read.pending;
  assert.equal(h.ui.chatDraft, 'more words in this draft');
  assert.equal(h.view.selectedAttachments[0].inlineData.name, 'same-draft.txt');
});

test('one chat draft accepts every file in a sequential multi-file read', async t => {
  const h = fixture(t);
  const pending = h.view.onPasteFiles(['first.txt', 'second.txt'].map(name => ({ name, type: 'text/plain', size: 10 })));
  const first = readers.at(-1); first.finish(); await vue.nextTick();
  const second = readers.at(-1); assert.notEqual(second, first); second.finish(); await pending;
  assert.deepEqual(h.view.selectedAttachments.map(part => part.inlineData.name), ['first.txt', 'second.txt']);
});

test('an identical-text replacement during the settings save barrier invalidates the old submission', async t => {
  const h = fixture(t); h.ui.setComposerDraft('same text');
  let release; h.profiles.awaitSavedForScope = () => new Promise(resolve => { release = resolve; });
  const pending = h.view.submit(); h.ui.replaceChatDraft('same text'); release(); await pending;
  assert.deepEqual(h.sent(), []); assert.equal(h.ui.chatDraft, 'same text');
});
