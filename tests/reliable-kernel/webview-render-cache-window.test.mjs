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
