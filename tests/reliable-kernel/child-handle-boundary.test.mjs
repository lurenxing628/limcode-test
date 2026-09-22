import assert from 'node:assert/strict';
import path from 'node:path';
import { createRequire } from 'node:module';
import test from 'node:test';

const require = createRequire(import.meta.url);
const root = process.env.LIMCODE_TEST_EXTENSION_ROOT || path.resolve('dist/extension');
const { buildModelHandleCatalog, resolveModelToolArguments, projectToolResultForModel } =
  require(path.join(root, 'backend/reliableKernel/modelHandleCatalog.js'));
const catalog = buildModelHandleCatalog([{ answerBridgeIds: ['bridge-first', 'bridge-second'] }]);
const { projectToolResultBatch } = require(path.join(root, 'backend/reliableKernel/modelFacingContextProjection.js'));

test('multi-child wait resolves all frozen references without changing caller input', () => {
  const input = { operation: 'wait', childRefs: ['A2', 'A1'], timeoutMs: 0 };
  assert.deepEqual(resolveModelToolArguments('run_agent', input, catalog), {
    operation: 'wait', answerBridgeIds: ['bridge-second', 'bridge-first'], timeoutMs: 0
  });
  assert.deepEqual(input.childRefs, ['A2', 'A1']);
  assert.deepEqual(projectToolResultForModel('run_agent', {
    answerBridgeIds: ['bridge-second', 'bridge-first'], status: 'running'
  }, catalog), { childRefs: ['A2', 'A1'], status: 'running' });
});

test('invalid or conflicting child references cannot silently select a different child', () => {
  for (const args of [
    { childRef: '' }, { childRef: 1 }, { childRef: 'A3' },
    { childRef: 'A1', answerBridgeId: 'bridge-second' },
    { childRefs: [] }, { childRefs: ['A1', 'A3'] },
    { childRefs: ['A1'], answerBridgeIds: ['bridge-second'] },
    { childRefs: Array(33).fill('A1') }
  ]) {
    assert.throws(() => resolveModelToolArguments('run_agent', { operation: 'send', ...args }, catalog),
      error => error.code === 'UNKNOWN_MODEL_HANDLE_REFERENCE');
  }
});

test('a squeezed parallel read preserves its current-page retry cursor as well as the next cursor', () => {
  const rereadCursor = 'r'.repeat(1_100);
  const batch = projectToolResultBatch(Array.from({ length: 8 }, (_, index) => ({
    toolName: 'run_agent', response: { operation: 'read', scope: 'direct', childRef: `A${index + 1}`,
      rereadCursor, nextCursor: `next-${index}`, timelineSources: [{ text: '正文'.repeat(10_000) }] }
  })), { perResultTokens: 200, batchTokens: 1_000 });
  for (const [index, item] of batch.items.entries()) {
    assert.equal(item.truncated, true);
    assert.equal(item.response.operation, 'read');
    assert.equal(item.response.childRef, `A${index + 1}`);
    assert.equal(item.response.rereadCursor, rereadCursor);
    assert.equal(item.response.nextCursor, `next-${index}`);
  }
});
