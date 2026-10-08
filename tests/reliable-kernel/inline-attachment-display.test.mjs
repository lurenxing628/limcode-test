import assert from 'node:assert/strict';
import { before, after, test } from 'node:test';
import { renderToString } from '@vue/server-renderer';
import { createWebviewSsrServer } from './webview-ssr-server.mjs';

let server, vue, InlineDataPartView, AttachmentThumbnail, protocol;
const posted = [], hostListeners = new Set();
const previousWindow = globalThis.window;
before(async () => {
  globalThis.window = {
    addEventListener(type, listener) { if (type === 'message') hostListeners.add(listener); },
    removeEventListener(type, listener) { if (type === 'message') hostListeners.delete(listener); },
    setTimeout, clearTimeout, requestAnimationFrame: callback => setTimeout(callback, 0), cancelAnimationFrame: clearTimeout,
    acquireVsCodeApi() { return { postMessage(message) { posted.push(message); }, getState() {}, setState() {} }; }
  };
  server = await createWebviewSsrServer();
  vue = await import('vue');
  InlineDataPartView = (await server.ssrLoadModule('/src/components/content/parts/InlineDataPartView.vue')).default;
  AttachmentThumbnail = (await server.ssrLoadModule('/src/components/input/AttachmentThumbnail.vue')).default;
  ({ BridgeMessageType: protocol } = await server.ssrLoadModule('/@fs' + process.cwd() + '/shared/protocol.ts'));
});
after(async () => { await server?.close(); globalThis.window = previousWindow; });

const image = (attachmentId, mimeType = 'image/png') => ({ inlineData: {
  attachmentId, sha256: `content-${attachmentId}`, mimeType, sizeBytes: 8, storage: 'managed', status: 'available', name: 'image.png'
} });
const embedded = data => ({ inlineData: { mimeType: 'image/png', name: 'image.png', data, sizeBytes: 8, storage: 'embedded' } });

function fixture(t, initial, component = InlineDataPartView) {
  const part = vue.ref(initial), start = posted.length;
  const renderer = vue.createRenderer({ createElement: () => ({}), createText: () => ({}), createComment: () => ({}),
    setText() {}, setElementText() {}, parentNode() { return null; }, nextSibling() { return null; }, insert() {}, remove() {}, patchProp() {} });
  let view;
  const mountedComponent = { ...component, render() { return null; }, ssrRender: undefined };
  const app = renderer.createApp({ setup() {
    return () => vue.h(mountedComponent, { part: part.value, ref: instance => { view = instance?.$?.setupState; } });
  } });
  app.provide(vue.ssrContextKey, { modules: new Set() });
  app.mount({});
  t.after(() => app.unmount());
  return {
    get view() { return view; },
    requests: () => posted.slice(start).filter(message => message.type === protocol.AttachmentReload),
    set(next) { part.value = next; return vue.nextTick(); },
    mutate(action) { action(part.value); },
    reply(request, result = { part: { inlineData: { ...request.payload, data: 'cHJldmlldw==', status: 'available', storage: 'managed', sizeBytes: 8 } }, status: 'available' }) {
      for (const listener of hostListeners) listener({ data: { id: 'fixture-reply', type: protocol.AttachmentReloadResult, correlationId: request.id, payload: result } });
    },
    unmount() { app.unmount(); }
  };
}

test('message images and draft thumbnails load automatically; other attachments wait for expansion', async t => {
  const message = fixture(t, image('message')), thumbnail = fixture(t, image('draft'), AttachmentThumbnail);
  assert.equal(message.view.expanded, true);
  assert.equal(message.requests().filter(request => request.payload.attachmentId === 'message').length, 1);
  assert.equal(thumbnail.requests().filter(request => request.payload.attachmentId === 'draft').length, 1);
  const file = fixture(t, image('text', 'text/plain'));
  assert.equal(file.view.expanded, false); assert.equal(file.requests().length, 0);
  file.view.setExpanded(true);
  assert.equal(file.requests().length, 1);
  file.reply(file.requests()[0]);
  assert.match(file.view.dataUri, /^data:text\/plain;base64,/);
});

test('attachment switches discard old replies, including a same-tick A to B to A replacement', async t => {
  const h = fixture(t, image('A')), first = h.requests()[0];
  // Mutate an already reactive prop to exercise the synchronous identity boundary without a render tick.
  h.mutate(part => { part.inlineData.attachmentId = 'B'; part.inlineData.attachmentId = 'A'; });
  const latest = h.requests().at(-1);
  assert.notEqual(latest.id, first.id);
  h.reply(first); assert.equal(h.view.dataUri, ''); assert.equal(h.view.loading, true);
  h.reply(latest); assert.match(h.view.dataUri, /^data:image\/png;base64,/);
  await h.set(image('C', 'image/jpeg'));
  const changed = h.requests().at(-1);
  h.reply(latest); assert.equal(h.view.dataUri, '');
  h.reply(changed); assert.match(h.view.dataUri, /^data:image\/jpeg;base64,/);
});

test('metadata updates preserve loaded bytes, embedded replacements update bytes, and failed reads do not loop', async t => {
  const h = fixture(t, image('A')), request = h.requests()[0];
  h.reply(request); const loaded = h.view.dataUri;
  await h.set({ inlineData: { ...image('A').inlineData, name: 'renamed.png' } });
  assert.equal(h.view.dataUri, loaded); assert.equal(h.requests().length, 1);
  const draft = fixture(t, embedded('YQ=='), AttachmentThumbnail);
  assert.equal(draft.requests().length, 0);
  await draft.set(embedded('Yg=='));
  assert.equal(draft.view.dataUri, 'data:image/png;base64,Yg==');
  const failed = fixture(t, image('missing'));
  failed.reply(failed.requests()[0], { status: 'missing', error: 'missing fixture' });
  await failed.set({ inlineData: { ...image('missing').inlineData, name: 'renamed.png' } });
  assert.equal(failed.requests().length, 1);
  assert.equal(failed.view.inlineData.status, 'missing');
  assert.equal(failed.view.inlineData.error, 'missing fixture');
  failed.view.reload(); assert.equal(failed.requests().length, 2);
});

test('unmount ignores pending bytes and production templates expose the image without a click', async t => {
  const h = fixture(t, image('unmount')), view = h.view, request = h.requests()[0];
  h.unmount(); h.reply(request); assert.equal(view.dataUri, '');
  for (const component of [InlineDataPartView, AttachmentThumbnail]) {
    const html = await renderToString(vue.createSSRApp(component, { part: embedded('YQ==') }));
    assert.match(html, /<img[^>]+src="data:image\/png;base64,YQ=="/);
  }
});
