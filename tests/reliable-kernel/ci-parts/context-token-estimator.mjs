import assert from 'node:assert/strict';

import test from 'node:test';

import * as kernel from '../../../dist/extension/backend/reliableKernel/index.js';

const MESSAGE_TYPE = 'application/vnd.limcode.message+json';

const TOOL_PAIR_TYPE = 'application/vnd.limcode.context-tool-pair+json';

function registerCases(test) {

test('Reliable Context信封解码后同批结果共用16K且原CAS派生对象不变', () => {
  const stored = [{
    segmentKind: 'message',
    messageRole: 'model',
    contentType: MESSAGE_TYPE,
    content: JSON.stringify({
      role: 'model',
      parts: [
        { id: 'call-a', functionCall: { name: 'read', args: { path: '/a' } } },
        { id: 'call-b', functionCall: { name: 'read', args: { path: '/b' } } }
      ]
    })
  }, ...['a', 'b'].map((name) => ({
    segmentKind: 'tool_pair',
    messageRole: null,
    contentType: TOOL_PAIR_TYPE,
    content: JSON.stringify({
      kind: 'tool_pair',
      toolCall: { id: `tool-${name}`, providerCallId: `call-${name}`, toolName: 'read' },
      toolModelResult: { id: `result-${name}`, result: JSON.stringify({ text: name.repeat(100_000) }) }
    })
  }))];
  const projectedStored = kernel.projectStoredModelFacingWindow(stored);
  assert.equal(projectedStored.contents.length, 3);
  assert.equal(projectedStored.toolResultBatches.length, 1);
  assert.ok(projectedStored.toolResultBatches[0].projectedTokens <= 16_000);

  const source = [
    { toolName: 'read', callId: 'a', resultId: 'ra', response: { path: '/a', text: 'BEGIN-A' + 'a'.repeat(80_000) + 'END-A' } },
    { toolName: 'shell', callId: 'b', resultId: 'rb', response: { processRef: 'P1', exitCode: 1, text: 'BEGIN-B' + 'b'.repeat(80_000) + 'END-B' }, priority: 'error_or_receipt', reread: { kind: 'process_output', processRef: 'P1' } },
    { toolName: 'tiny', callId: 'c', resultId: 'rc', response: { ok: true, value: 7 } }
  ];
  const before = structuredClone(source);
  const first = kernel.projectToolResultBatch(source);
  assert.deepEqual(source, before);
  assert.deepEqual(first, kernel.projectToolResultBatch(source));
  assert.equal(first.items.length, source.length);
  assert.ok(first.items.every((item) => !Object.hasOwn(item, 'digest')));
  assert.equal(Object.hasOwn(first.items[1].response, 'sha256'), false);
  assert.equal(first.items[2].truncated, false);
  assert.deepEqual(first.items[2].response, source[2].response);
  assert.ok(first.projectedTokens <= 16_000);
  assert.equal(first.items[1].response.processRef, 'P1');
  assert.equal(first.items[1].response.rereadHint.processRef, 'P1');
  assert.match(first.items[1].response.preview, /BEGIN-B/);
  assert.match(first.items[1].response.preview, /END-B/);
});
}

export { registerCases };
