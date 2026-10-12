import { createWebviewSsrServer } from './webview-ssr-server.mjs';

// One production Vue module graph for all input, feed and history scenarios. Native Webview
// APIs are the external boundary; components, watchers, Pinia and bridge normalization stay real.
export async function createUiWorkflowFixture() {
  const original = Object.fromEntries(['window', 'document', 'FileReader'].map(key => [key, globalThis[key]]));
  const posted = [], readers = [], listeners = new Set(), timers = new Map();
  let nextTimer = 0, persisted = {}, sequence = 0;
  globalThis.window = {
    addEventListener(type, listener) { if (type === 'message') listeners.add(listener); },
    removeEventListener(type, listener) { if (type === 'message') listeners.delete(listener); },
    setTimeout(fn, ms) { const id = ++nextTimer; timers.set(id, { fn, ms }); return id; },
    clearTimeout(id) { timers.delete(id); }, requestAnimationFrame() {}, cancelAnimationFrame() {},
    acquireVsCodeApi: () => ({ postMessage(message) { posted.push(structuredClone(message)); },
      getState: () => persisted, setState(value) { persisted = structuredClone(value); } })
  };
  globalThis.FileReader = class {
    readAsDataURL(file) { this.file = file; readers.push(this); }
    finish() { this.result = `data:${this.file.type};base64,YXR0YWNobWVudA==`; this.onload(); }
  };
  const server = await createWebviewSsrServer();
  const vue = await import('vue'), pinia = await import('pinia');
  const { renderToString } = await import('@vue/server-renderer');
  const load = name => server.ssrLoadModule(name.startsWith('/') ? name : `/src/${name}`);
  const [clientModule, uiModule, profileModule, feedModule, chatModule, protocol, traceModule,
    composerModule, queueModule, listModule, persistenceModule, prefillModule] = await Promise.all([
    load('stores/useClientStateStore.ts'), load('stores/useConversationUiStore.ts'),
    load('stores/useModelProfileStore.ts'), load('stores/useReliableKernelClientFeedStore.ts'),
    load('composables/useChat.ts'), server.ssrLoadModule(`${process.cwd()}/shared/protocol.ts`),
    load('transport/debugCapture.ts'), load('components/input/Composer.vue'),
    load('components/input/ReliableQueuePanel.vue'), load('components/conversation/ReliableMessageList.vue'),
    load('components/input/composerDraftPersistence.ts'), load('components/input/chatDraftPrefill.ts')
  ]);
  globalThis.document = { documentElement: { clientWidth: 1280, clientHeight: 800 } };
  const renderer = vue.createRenderer({ createElement: () => ({}), createText: () => ({}), createComment: () => ({}),
    setText() {}, setElementText() {}, parentNode() { return null; }, nextSibling() { return null; },
    insert() {}, remove() {}, patchProp() {} });
  function stores(t) {
    persisted = {};
    const active = pinia.createPinia(); pinia.setActivePinia(active);
    const scope = vue.effectScope();
    const client = clientModule.useClientStateStore(), ui = uiModule.useConversationUiStore();
    const profiles = profileModule.useModelProfileStore(), feed = feedModule.useReliableKernelClientFeedStore();
    const conversationId = `ui-workflow-${++sequence}`;
    client.currentConversationId = conversationId;
    feed.projections = { activeConversationWindow: { conversationId } };
    feed.sessionId = 'session'; feed.snapshotRequired = false;
    const preview = JSON.stringify({ version: 3, kind: 'guidance', text: 'queued input', editorText: 'queued input',
      revisionSeq: '1', position: '1', hold: 'none' });
    for (const id of ['intent', 'queued']) feed.details[`turn-intent-preview:${id}`] = { status: 'ready', text: preview, totalBytes: preview.length };
    const cleanup = [];
    t.after(() => {
      for (const close of cleanup.reverse()) close();
      scope.stop();
      for (const id of Object.keys(feed.pendingDetails)) feed.finishDetailRequest(id);
      pinia.disposePinia(active); timers.clear(); traceModule.debugCaptureTrace.update();
    });
    const emit = message => { for (const listener of [...listeners]) listener({ data: structuredClone(message) }); };
    const ack = (submission, payload = {}) => emit({ type: protocol.BridgeMessageType.TurnInputResult,
      correlationId: submission.requestId, payload: { commandId: submission.commandId, conversationId,
        requestType: submission.requestType, status: 'accepted', admitted: true, turnId: 'turn', ...payload } });
    async function render(component, props = {}) {
      await vue.nextTick(); let setup;
      const app = vue.createSSRApp(component, props).use(active);
      app.mixin({ created() { if (this.$.type.__name === component.__name) setup = this.$.setupState; } });
      return { html: await renderToString(app), setup };
    }
    return { active, scope, client, ui, profiles, feed, conversationId, emit, ack, render, cleanup,
      useChat: () => scope.run(() => chatModule.useChat()),
      message(turnId = 'turn', messageId = 'input', revisionId = 'revision') {
        feed.records = { ...feed.records,
          Turn: { ...feed.records.Turn, [turnId]: { id: turnId, conversation_id: conversationId, status: 'active' } },
          Message: { ...feed.records.Message, [messageId]: { id: messageId, conversation_id: conversationId,
            revision_id: revisionId, revision_seq: '1', role: 'user', message_seq: '1', created_at: '2026-10-08T00:00:00Z' } },
          MessageTurnLink: { ...feed.records.MessageTurnLink, [`link-${messageId}`]: {
            id: `link-${messageId}`, turn_id: turnId, message_id: messageId, role: 'input' } } };
      },
      body(revisionId = 'revision', text = 'durable body') {
        const value = JSON.stringify({ role: 'user', parts: [{ text }] });
        feed.details[`message-content:${revisionId}`] = { status: 'ready', text: value, totalBytes: value.length };
      }
    };
  }
  function composer(t) {
    const h = stores(t), start = posted.length;
    h.profiles.activateScope = () => () => {};
    h.profiles.awaitSavedForScope = async () => {};
    const app = renderer.createApp({ ...composerModule.default, render() { return null; }, ssrRender: undefined }).use(h.active);
    app.provide(vue.ssrContextKey, { modules: new Set() });
    const view = app.mount({}).$.setupState;
    h.cleanup.push(() => app.unmount());
    return { ...h, view,
      sent: () => posted.slice(start).filter(message => message.type === protocol.BridgeMessageType.TurnStart || message.type === protocol.BridgeMessageType.TurnEnqueue),
      read(name = 'attachment.txt') {
        const pending = view.onPasteFiles([{ name, type: 'text/plain', size: 10 }]);
        const reader = readers.at(-1);
        return { pending, finish: () => reader.finish() };
      }
    };
  }
  return { server, vue, pinia, load, posted, readers, timers, protocol: protocol.BridgeMessageType,
    renderToString, stores, composer, queue: queueModule.default, messageList: listModule.default,
    persistence: persistenceModule.useComposerDraftPersistence, prefill: prefillModule.useChatDraftPrefill,
    renderer, async close() { traceModule.debugCaptureTrace.update(); await server.close(); Object.assign(globalThis, original); } };
}

export function viewState() {
  let value, generation = 0;
  return { read: () => value, write: next => { value = next === undefined ? undefined : structuredClone(next); },
    session() { const own = ++generation; return { read: () => value,
      write: next => { if (own === generation) value = next === undefined ? undefined : structuredClone(next); } }; },
    reload() { generation++; } };
}

export function persistedComposer(t, fixture, state, options = {}) {
  const h = fixture.stores(t), { vue } = fixture;
  const attachments = vue.ref({ chat: [], edit: [] });
  const conversationId = vue.ref(options.conversationId), messages = vue.shallowRef(options.messages ?? []);
  let discarded = 0;
  const page = new EventTarget();
  const persistence = h.scope.run(() => fixture.persistence({ ui: h.ui, attachments,
    conversationId: () => conversationId.value, findMessage: id => messages.value.find(message => message.id === id),
    storage: state.session(), pendingInputCommands: () => options.pendingInputCommands ?? [], pageEvents: page,
    onEditDiscarded: () => { discarded++; } }));
  h.scope.run(() => vue.watch(() => h.ui.composerHighlightKey, () => {
    if (h.ui.isEditing) attachments.value = { ...attachments.value,
      edit: (h.ui.editingMessage?.message.content.parts ?? []).filter(part => 'inlineData' in part).map(part => structuredClone(vue.toRaw(part))) };
  }));
  h.cleanup.push(() => persistence.dispose());
  return { ...h, attachments, conversationId, messages, page, persistence, discarded: () => discarded,
    reload() { state.reload(); h.scope.stop(); } };
}
