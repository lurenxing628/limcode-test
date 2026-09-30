import assert from 'node:assert/strict';
import test from 'node:test';
import { createRequire } from 'node:module';
import { createWebviewSsrServer } from './webview-ssr-server.mjs';
const require = createRequire(import.meta.url);
const { createSSRApp, h } = require('vue');
const { renderToString } = require('@vue/server-renderer');

const ready = (text) => ({ status: 'ready', text, totalBytes: text.length });

test('loaded immutable results and messages above 8 MiB are not reparsed on streaming frames; replacements invalidate', async () => {
  const server = await createWebviewSsrServer();
  try {
    const { projectReliableConversation: project } = await server.ssrLoadModule('/src/domain/reliableConversationProjection.ts');
    const records = { Message: {}, MessageTurnLink: {}, Turn: {}, ToolCall: {}, ToolCallSourceLink: {}, ToolOutcome: {} };
    const details = {};
    for (let i = 0; i < 60; i++) {
      const id = String(i);
      records.Message[id] = { id, conversation_id: 'cache-test', role: 'model', revision_id: id, message_seq: id };
      records.MessageTurnLink[id] = { id, message_id: id, turn_id: id, role: 'model' };
      records.Turn[id] = { id, conversation_id: 'cache-test', status: 'terminated' };
      records.ToolCall[id] = { id, turn_id: id, tool_name: 'read', status: 'terminal', call_seq: '1' };
      records.ToolCallSourceLink[id] = { id, tool_call_id: id, message_id: id, provider_call_id: id, provider_ordinal: 0 };
      records.ToolOutcome[id] = { id, tool_call_id: id, status: 'succeeded' };
      details[`message-content:${id}`] = ready(JSON.stringify({ role: 'model', parts: [{ text: 'm'.repeat(200000) }, { id, functionCall: { name: 'read', args: {} } }] }));
      details[`tool-result-content:${id}`] = ready(JSON.stringify({ detail: { output: { content: 'r'.repeat(200000) }, parts: [{ inlineData: { mimeType: 'image/png', attachmentId: id } }] } }));
    }
    const input = { conversationId: 'cache-test', records, details };
    const first = project(input);
    const original = JSON.parse;
    let parses = 0;
    JSON.parse = (...args) => { parses++; return original(...args); };
    try {
      for (let frame = 0; frame < 40; frame++) {
        const next = project({ ...input, lastCommitSeq: String(frame) });
        assert.equal(next.toolCalls.length, 60);
        assert.strictEqual(next.toolResultByCallId['0'], first.toolResultByCallId['0']);
        assert.strictEqual(next.toolCalls[0].responseParts, first.toolCalls[0].responseParts);
        assert.strictEqual(next.messages[0].content, first.messages[0].content);
      }
      assert.equal(parses, 0);
    } finally { JSON.parse = original; }
    details['tool-result-content:0'] = ready('{"detail":{"replacement":true}}');
    assert.deepEqual(project(input).toolResultByCallId['0'], { replacement: true });
    // Guard even an in-place ready-detail replacement, although normal feed writes replace it.
    details['tool-result-content:0'].text = '{"detail":{"mutated":true}}';
    assert.deepEqual(project(input).toolResultByCallId['0'], { mutated: true });
    delete details['tool-result-content:0'];
    assert.equal(project(input).toolResultByCallId['0'], undefined);
    details['tool-result-content:0'] = ready('{"detail":{"reloaded":true}}');
    assert.deepEqual(project(input).toolResultByCallId['0'], { reloaded: true });
  } finally { await server.close(); }
});

test('large code blocks SSR only a bounded line window with line positions and complete short/long text', async () => {
  const server = await createWebviewSsrServer();
  try {
    const { default: CodeBlock } = await server.ssrLoadModule('/src/components/content/CodeBlockViewer.vue');
    const render = (code) => renderToString(createSSRApp({ render: () => h(CodeBlock, { code, language: 'js' }) }));
    const html = await render(Array.from({ length: 10000 }, (_, i) => `line-${i + 1}`).join('\n'));
    assert.ok((html.match(/class="lc-code-block-line"/g) ?? []).length < 80);
    assert.match(html, /aria-setsize="10000"/);
    assert.match(html, /aria-posinset="1"/);
    assert.match(html, /line-1</);
    assert.doesNotMatch(html, /line-10000</);
    const short = await render('first\r\nsecond\rthird\n');
    assert.equal((short.match(/class="lc-code-block-line"/g) ?? []).length, 3);
    assert.match(short, /third</);
    assert.match(await render('x'.repeat(200000)), new RegExp('x'.repeat(1000)));
    assert.equal(((await render('')).match(/class="lc-code-block-line"/g) ?? []).length, 1);
  } finally { await server.close(); }
});

test('variable-height code window reaches middle/end, preserves long wrapped lines and rebuilds streamed prefixes', async () => {
  const server = await createWebviewSsrServer();
  try {
    const { CodeLineHeights, codeLineWindow } = await server.ssrLoadModule('/src/domain/codeLineWindow.ts');
    const heights = new CodeLineHeights(10000, 20);
    assert.equal(heights.offset(10000), 200000);
    heights.set(100, 20000);
    assert.equal(heights.indexAt(2001), 100);
    assert.equal(heights.indexAt(21999), 100);
    assert.equal(heights.indexAt(22000), 101);
    const middle = codeLineWindow(heights, heights.offset(5000), 520);
    assert.ok(middle.start <= 5000 && middle.end > 5020);
    assert.ok(middle.end - middle.start < 80);
    assert.equal(middle.before + (heights.offset(middle.end) - heights.offset(middle.start)) + middle.after, heights.offset(10000));
    const tail = codeLineWindow(heights, heights.offset(10000) - 520, 520);
    assert.equal(tail.end, 10000);
    const streamed = new CodeLineHeights(10001, 20, (index) => index < heights.count ? heights.height(index) : 20);
    assert.equal(streamed.height(100), 20000);
    assert.equal(streamed.offset(10001), heights.offset(10000) + 20);
    // Invalid measurements must not poison scrolling offsets.
    streamed.set(100, 0); streamed.set(100, NaN); streamed.set(-1, 10);
    assert.equal(streamed.height(100), 20000);
  } finally { await server.close(); }
});

test('unchanged mounted rows settle without a ResizeObserver frame loop; wrap/width retain logical anchor', async () => {
  const server = await createWebviewSsrServer();
  try {
    const { CodeLineHeights, codeLineAnchor, codeLineAnchorOffset, syncCodeLineObservers } = await server.ssrLoadModule('/src/domain/codeLineWindow.ts');
    const rows = new Set([{}, {}, {}]);
    const observed = new Set();
    let scheduled = 1;
    let frames = 0;
    let observes = 0;
    let removes = 0;
    const observer = { observe() { observes++; scheduled++; }, unobserve() { removes++; } };
    // Fake ResizeObserver's mandatory initial notification. Re-observing in each measurement
    // would never empty this queue; the actual component uses this exact synchronization helper.
    while (scheduled && frames < 20) {
      scheduled = 0; frames++;
      syncCodeLineObservers(observer, observed, rows);
    }
    assert.equal(frames, 2);
    assert.equal(scheduled, 0);
    assert.equal(observes, 3);
    rows.delete(rows.values().next().value); rows.add({});
    syncCodeLineObservers(observer, observed, rows);
    assert.equal(observes, 4); assert.equal(removes, 1);
    const wrapped = new CodeLineHeights(10000, 80);
    wrapped.set(5000, 20000);
    const anchor = codeLineAnchor(wrapped, wrapped.offset(5000) + 10000);
    const resized = new CodeLineHeights(10000, 19);
    assert.equal(resized.indexAt(codeLineAnchorOffset(resized, anchor)), 5000);
    // Once the new width's real wrapped height is measured, retain the same relative position.
    resized.set(5000, 10000);
    assert.equal(codeLineAnchorOffset(resized, anchor), resized.offset(5000) + 5000);
    assert.deepEqual(codeLineAnchor(resized, codeLineAnchorOffset(resized, anchor)), anchor);
  } finally { await server.close(); }
});

test('offscreen nowrap width accounts for wide Unicode and tabs', async () => {
  const server = await createWebviewSsrServer();
  try {
    const { codeLineColumns, CodeLineHeights, codeLineAnchorOffset } = await server.ssrLoadModule('/src/domain/codeLineWindow.ts');
    assert.equal(codeLineColumns('plain'), 5);
    assert.equal(codeLineColumns('中文注释\tX'), 11);
    assert.equal(codeLineColumns('🙂🙂'), 4);
    const heights = new CodeLineHeights(2, 19);
    assert.ok(codeLineAnchorOffset(heights, { index: 0, fraction: 1 }) < 19, 'within-line offset never moves into the next line');
  } finally { await server.close(); }
});

test('code-block content updates retain the reading line and pixel offset through real watchers and measurements', async () => {
  const server = await createWebviewSsrServer();
  const vue = require('vue');
  const scope = vue.effectScope();
  try {
    const { default: CodeBlock } = await server.ssrLoadModule('/src/components/content/CodeBlockViewer.vue');
    const { codeLineAnchor } = await server.ssrLoadModule('/src/domain/codeLineWindow.ts');
    const props = vue.reactive({ code: 'a'.repeat(10000), language: 'js', info: '' });
    let state;
    // Call actual setup outside Vue's SSR setup phase, which deliberately skips normal watchers.
    // Mounted-only observers stay inactive; production measureRows reads synthetic row geometry.
    const app = createSSRApp({});
    app.provide(vue.ssrContextKey, { modules: new Set() });
    const warnings = [];
    const warn = console.warn;
    try {
      console.warn = (...args) => warnings.push(args.join(' '));
      state = app.runWithContext(() => scope.run(() => CodeBlock.setup(props, { expose() {} })));
    } finally { console.warn = warn; }
    assert.equal(warnings.length, 2);
    assert.ok(warnings.some(warning => /onMounted.*no active component instance/.test(warning)));
    assert.ok(warnings.some(warning => /onBeforeUnmount.*no active component instance/.test(warning)));
    const rows = new Map();
    const actualHeight = index => Math.max(19, state.lines.value[index]?.length ?? 0);
    const scrollHeight = () => {
      const range = state.windowRange.value;
      let height = range.before + range.after + 18;
      for (let index = range.start; index < range.end; index++) height += actualHeight(index);
      return height;
    };
    let domTop = 0;
    const scroller = {
      clientWidth: 400,
      get clientHeight() { return Math.min(520, scrollHeight()); },
      get scrollHeight() { return scrollHeight(); },
      get scrollTop() { return domTop; },
      set scrollTop(value) { domTop = Math.max(0, Math.min(value, scrollHeight() - this.clientHeight)); },
      querySelectorAll() {
        const range = state.windowRange.value;
        const visible = [];
        for (let index = range.start; index < range.end; index++) {
          if (!rows.has(index)) rows.set(index, {
            dataset: { lineIndex: String(index) },
            getBoundingClientRect: () => ({ height: actualHeight(index), width: 400 })
          });
          visible.push(rows.get(index));
        }
        return visible;
      }
    };
    state.scroller.value = scroller;
    const measure = async () => {
      await vue.nextTick();
      state.measureRows();
      await vue.nextTick();
    };
    await measure();
    scroller.scrollTop = 5006;
    state.onScroll();
    for (const suffix of ['b'.repeat(1000), 'c'.repeat(10000)]) {
      props.code += suffix;
      await vue.nextTick();
      state.onScroll(); // The browser's event for our own synchronized/clamped write is inert.
      await measure();
      assert.equal(scroller.scrollTop, 5006, 'appending to the visible wrapped line must keep its already-read prefix');
      assert.equal(state.scrollTop.value, 5000);
    }

    props.code = `${'p'.repeat(2000)}\n${'a'.repeat(10000)}\ntail`;
    await measure();
    scroller.scrollTop = 2506;
    state.onScroll();
    props.code = `${'p'.repeat(100)}\n${'a'.repeat(10000)}\ntail`;
    await measure();
    assert.equal(scroller.scrollTop, 606, 'shrinking a preceding line retains logical line 2 and its 500px reading offset');
    props.code = `${'p'.repeat(10000)}\n${'a'.repeat(10000)}\ntail`;
    await measure();
    assert.equal(scroller.scrollTop, 10506, 'growing a preceding line shifts only the preserved line prefix');

    props.code = `${'p'.repeat(10000)}\nshort\ntail`;
    await measure();
    assert.equal(scroller.scrollTop, scrollHeight() - scroller.clientHeight, 'a shortened reading line clamps to the actual scroll range');
    props.code = 'short';
    await measure();
    assert.equal(scroller.scrollTop, 0, 'replacement with short content cannot keep a stale position beyond the new end');
    assert.equal(state.windowRange.value.end, 1);
    const settledRevision = state.heightRevision.value;
    await measure();
    assert.equal(state.heightRevision.value, settledRevision, 'unchanged measurements settle after consuming the content anchor');

    props.code = Array.from({ length: 200 }, (_, index) => `line-${index}`).join('\n');
    await measure();
    scroller.scrollTop = 1006;
    state.onScroll();
    props.code += '\nnew-output';
    await vue.nextTick();
    scroller.scrollTop = 1306;
    state.onScroll();
    await measure();
    assert.equal(scroller.scrollTop, 1306, 'a user scroll after the content watcher supersedes its pending reading anchor');

    props.code += '\nundelivered-output';
    await vue.nextTick();
    await vue.nextTick();
    scroller.scrollTop = 1456;
    await measure();
    assert.equal(scroller.scrollTop, 1456, 'measurement first adopts a new DOM position even when its scroll event is still pending');
    assert.equal(state.scrollTop.value, 1450);

    props.code += '\nnext-output';
    await vue.nextTick();
    state.measureRows();
    scroller.scrollTop = 1606;
    state.onScroll();
    await vue.nextTick();
    assert.equal(scroller.scrollTop, 1606, 'a queued measurement restore cannot overwrite a newer delivered user scroll');

    props.code += '\nmore-output';
    await vue.nextTick();
    state.measureRows();
    scroller.scrollTop = 1906; // Scroll event delivery can lag behind the compositor's DOM position.
    await vue.nextTick();
    assert.equal(scroller.scrollTop, 1906, 'a queued measurement restore checks the DOM even before the scroll event arrives');
    assert.equal(state.scrollTop.value, 1900);

    props.code += '\nlast-output';
    await Promise.resolve(); // Watcher ran; its nextTick restore has not run yet.
    assert.equal(state.heights.value.count, 205);
    scroller.scrollTop = 2206;
    await vue.nextTick();
    assert.equal(scroller.scrollTop, 2206, 'the content watcher nextTick restore also respects an undelivered new user scroll');
    await measure();
    const userSettledRevision = state.heightRevision.value;
    await measure();
    assert.equal(state.heightRevision.value, userSettledRevision, 'superseded anchors do not leave continuing measurement work');

    props.code += '\nresized-output';
    await vue.nextTick();
    await vue.nextTick();
    scroller.scrollTop = 2336;
    state.syncScroll(false); // A viewport observer only synchronizes layout, not a user scroll.
    await measure();
    assert.equal(scroller.scrollTop, 2336, 'layout synchronization cannot hide an undelivered user scroll from measurement');

    scroller.scrollTop = 2406;
    const wrapAnchor = codeLineAnchor(state.heights.value, scroller.scrollTop - 6);
    state.toggleWrap();
    await measure();
    assert.deepEqual(codeLineAnchor(state.heights.value, scroller.scrollTop - 6), wrapAnchor,
      'wrap reset captures the newest DOM reading line even before its scroll event arrives');
    const wrapSettledRevision = state.heightRevision.value;
    await measure();
    assert.equal(state.heightRevision.value, wrapSettledRevision, 'wrap reset also consumes its preserved anchor once');
  } finally {
    scope.stop();
    await server.close();
  }
});

test('content reading anchors clamp removed lines and keep pixel offsets when a line grows', async () => {
  const server = await createWebviewSsrServer();
  try {
    const { CodeLineHeights, codeLineReadingAnchor, codeLineReadingAnchorOffset } = await server.ssrLoadModule('/src/domain/codeLineWindow.ts');
    const old = new CodeLineHeights(100, 19);
    old.set(50, 10000);
    const anchor = codeLineReadingAnchor(old, old.offset(50) + 5000);
    old.set(50, 20000);
    assert.equal(codeLineReadingAnchorOffset(old, anchor), old.offset(50) + 5000);
    const shortened = new CodeLineHeights(2, 19);
    const position = codeLineReadingAnchorOffset(shortened, anchor);
    assert.ok(position >= shortened.offset(1) && position < shortened.offset(2), 'a removed reading line falls back inside the last retained line');
    assert.equal(codeLineReadingAnchorOffset(new CodeLineHeights(0, 19), anchor), 0);
  } finally { await server.close(); }
});
