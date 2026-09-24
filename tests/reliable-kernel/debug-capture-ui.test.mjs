import assert from 'node:assert/strict';
import test from 'node:test';
import { createRequire } from 'node:module';
import { createWebviewSsrServer } from './webview-ssr-server.mjs';
const require = createRequire(import.meta.url);
const { normalizeDebugCaptureSettings } = require('../../dist/extension/shared/debugCapture.js');
const context = { conversationId: 'conversation-a', modelRequestId: 'request-a', attemptSeq: '1', socketGeneration: '1' };
const active = { runId: 'capture-a', status: 'recording', target: { scope: 'conversation', conversationId: 'conversation-a' } };
async function modules(t) {
  const server = await createWebviewSsrServer();
  t.after(() => server.close());
  const trace = await server.ssrLoadModule('/src/domain/debugCaptureTrace.ts');
  const model = await server.ssrLoadModule('/src/domain/reliableTransientModel.ts');
  return { ...trace, ...model };
}
test('界面关闭时不计算或发送记录，设置中不能恢复开启状态', async t => {
  const { DebugCaptureUiTrace } = await modules(t);
  let sent = 0; let calculated = 0;
  const trace = new DebugCaptureUiTrace('view', () => sent++);
  for (let i = 0; i < 100000; i++) trace.observe(context, () => { calculated++; return {}; });
  trace.flush(); assert.equal(sent, 0); assert.equal(calculated, 0);
  assert.equal('enabled' in normalizeDebugCaptureSettings({ enabled: true }), false);
});
test('真实界面参数合并记录实际追加、替换和完成，发送纯数据且批次有确认', async t => {
  const { DebugCaptureUiTrace, mergeReliableToolCallDeltas, mergeReliableCompletedToolCalls } = await modules(t);
  const sent = [];
  const trace = new DebugCaptureUiTrace('view', batch => sent.push(structuredClone(batch)));
  t.after(() => trace.update()); trace.update(active);
  let streamSeq = '1';
  const observe = change => trace.tool(context, { streamSeq, callId: change.callId, operation: change.operation, mode: 'apply' }, change.before, change.fragment, change.after);
  let calls = mergeReliableToolCallDeltas([], [{ id: 'tool-a', argumentsDelta: '{"x":' }], 'request-a', 1, undefined, observe);
  streamSeq = '2'; calls = mergeReliableToolCallDeltas(calls, [{ id: 'tool-a', argumentsDelta: '1}' }], 'request-a', 2, undefined, observe);
  streamSeq = '3'; calls = mergeReliableToolCallDeltas(calls, [{ id: 'tool-a', argumentsDelta: '{"x":2}', replace: true }], 'request-a', 3, undefined, observe);
  streamSeq = '4'; calls = mergeReliableCompletedToolCalls(calls, [{ id: 'tool-a', name: 'echo', arguments: { x: 2 } }], 'request-a', 4, undefined, observe);
  assert.equal(calls[0].argumentsText, '{"x":2}'); assert.equal(calls[0].final, true);
  trace.flush(); assert.equal(sent.length, 1);
  const events = sent[0].events;
  assert.equal(events.filter(e => e.stage === 'ui.tool_baseline').length, 1);
  assert.deepEqual(events.filter(e => e.stage === 'ui.tool_apply').map(e => [e.metadata.operation, e.payload, e.metadata.beforeChars, e.metadata.afterChars]), [
    ['append', '{"x":', 0, 5], ['append', '1}', 5, 7], ['replace', '{"x":2}', 7, 7], ['complete', '{"x":2}', 7, 7]
  ]);
  trace.acknowledge({ ...sent[0], accepted: true }); assert.equal(trace.inFlight, undefined);
  assert.ok(Buffer.byteLength(JSON.stringify(sent[0])) < 128 * 1024);
});
test('中途开启只保存一次本地起点，重建不冒充追加', async t => {
  const { DebugCaptureUiTrace, mergeReliableToolCallDeltas } = await modules(t);
  const sent = [];
  const trace = new DebugCaptureUiTrace('view', batch => sent.push(batch)); t.after(() => trace.update());
  let calls = mergeReliableToolCallDeltas([], [{ id: 'a', argumentsDelta: 'earlier' }], 'request-a', 1);
  trace.update(active);
  const observe = c => trace.tool(context, { streamSeq: '1', snapshotId: 'snapshot-a', callId: c.callId, mode: 'rebuild', operation: c.operation }, c.before, c.fragment, c.after);
  calls = mergeReliableToolCallDeltas(calls, [{ id: 'a', argumentsDelta: 'later' }], 'request-a', 2, undefined, observe);
  trace.flush();
  assert.equal(sent[0].events[0].payload, 'earlier'); assert.equal(sent[0].events[1].metadata.mode, 'rebuild');
  assert.equal(calls[0].argumentsText, 'earlierlater');
});
test('过大界面片段只停止取证；旧状态广播不能重新开启失败记录', async t => {
  const { DebugCaptureUiTrace } = await modules(t);
  const sent = []; const trace = new DebugCaptureUiTrace('view', batch => sent.push(batch));
  trace.update(active);
  trace.observe(context, () => ({ stage: 'ui.frame', metadata: {}, payload: 'x'.repeat(1024 * 1024) }));
  assert.equal(sent.length, 1); assert.ok(sent[0].gap); assert.equal(trace.pendingBytes, 0);
  trace.update(active); assert.equal(trace.active(context), false);
  assert.equal(trace.timer, undefined); assert.equal(trace.ackTimer, undefined);
});
