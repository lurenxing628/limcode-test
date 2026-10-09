import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import test from 'node:test';
const require = createRequire(import.meta.url);
const { ReliableToolDispatcher } = require('../../dist/extension/backend/reliableKernel/toolDispatcher.js');
const { EffectControlPlane } = require('../../dist/extension/backend/reliableKernel/effectControlPlane.js');
const { validateCommandToolArguments, commandToolArgumentMetadata } = require('../../dist/extension/shared/commandToolArguments.js');
const { resolveModelToolArguments, buildModelHandleCatalog } = require('../../dist/extension/backend/reliableKernel/modelHandleCatalog.js');

test('optional command budgets normalize into the actual process request and keep original arguments', async () => {
  const original = { mode: 'execute', command: 'echo tolerance', explanation: 'fixture',
    foregroundWaitMs: '90000', executionTimeoutMs: 99999999, maxOutputBytes: 512, processRef: 'P999', cursor: 'O999' };
  const snapshot = structuredClone(original), starts = [], waits = [];
  const dispatcher = Object.create(ReliableToolDispatcher.prototype);
  dispatcher.dependencies = {
    host: { async resolveProcessCwd(input) { assert.equal(input.arguments.processRef, undefined); return '/fixture'; } },
    processes: {
      async prepareStart(request) { starts.push(request); return { effect: { effectIntentId: 'intent' } }; },
      async dispatchStart(id, wait) { waits.push(wait); return { terminal: { toolCallId: 'call', status: 'succeeded' } }; }
    }
  };
  const result = await dispatcher.dispatchProcess({ toolName: 'bash', toolCallId: 'call', arguments: original }, {}, new AbortController().signal);
  assert.equal(result.status, 'succeeded');
  assert.deepEqual(waits, [60000]);
  assert.equal(starts[0].executionTimeoutMs, 600000);
  assert.equal(starts[0].maxOutputBytes, 1024);
  assert.deepEqual(original, snapshot);
  const metadata = commandToolArgumentMetadata(original);
  assert.deepEqual(metadata.adjustedArguments, { foregroundWaitMs: 60000, executionTimeoutMs: 600000, maxOutputBytes: 1024 });
  assert.deepEqual(metadata.ignoredFields, ['processRef', 'cursor']);
  assert.match(metadata.warning, /60000/);
  assert.throws(() => validateCommandToolArguments({ ...original, foregroundWaitMs: false }), /integer/);
});

test('unused references are not resolved, while references actually selected still require their catalog', () => {
  const catalog = buildModelHandleCatalog([{ processId: 'process', answerBridgeId: 'child', attachmentId: 'attachment' }]);
  for (const [name, args] of [
    ['read', { path: 'a.txt', attachmentRef: 'F999', items: [{ path: 'x' }] }],
    ['bash', { mode: 'execute', command: 'pwd', explanation: 'locate', processRef: 'P999', cursor: 'O999' }],
    ['run_agent', { operation: 'spawn', taskName: 'work', prompt: 'do work', childRef: 'A999', childRefs: ['A999'] }],
    ['run_agent', { operation: 'list', childRef: 'A999' }]
  ]) {
    assert.deepEqual(resolveModelToolArguments(name, args, catalog), args);
  }
  assert.throws(() => resolveModelToolArguments('read', { attachmentRef: 'F999' }, catalog), /F999/);
  assert.throws(() => resolveModelToolArguments('bash', { mode: 'output', processRef: 'P999' }, catalog), /P999/);
  assert.throws(() => resolveModelToolArguments('run_agent', { operation: 'send', childRef: 'A999', prompt: 'work' }, catalog), /A999/);
  const processRef = catalog.entries.find(entry => entry.target === 'process').ref;
  const attachmentRef = catalog.entries.find(entry => entry.target === 'attachment').ref;
  assert.deepEqual(resolveModelToolArguments('read', { attachmentRef, attachmentId: null }, catalog), { attachmentId: 'attachment' });
  const stopped = resolveModelToolArguments('bash', { mode: 'kill', processRef, cursor: 'O999' }, catalog);
  assert.equal(stopped.processId, 'process');
  assert.equal(stopped.cursor, 'O999');
});

test('production terminal metadata uses frozen raw arguments without changing result authority', async () => {
  const cases = [
    ['read', { path: 'a.txt', startLine: 1, endLine: 260, items: [{ path: '', startLine: 1, endLine: 1 }, { path: '', startLine: 1, endLine: 1 }] }, 'items'],
    ['run_agent', { operation: 'list', prompt: 'unused', interrupt: false, foregroundWaitMs: 0 }, 'prompt'],
    ['read_agent_answer', { answerBridgeId: 'child', prompt: 'unused' }, 'prompt'],
    ['update_task_list', { mode: 'rewrite', items: [{ title: 'work', delete: true }] }, 'items[0].delete']
  ];
  for (const [toolName, args, ignored] of cases) {
    const plane = Object.create(EffectControlPlane.prototype);
    plane.requireContentObject = async () => ({ id: 'frozen' });
    plane.contentStore = { async read() { return Buffer.from(JSON.stringify(args)); } };
    const detail = { existingFact: 'preserved' };
    const result = await plane.toolTerminalDetail({ tool_name: toolName, arguments_object_id: 'frozen' }, detail);
    assert.equal(result.existingFact, detail.existingFact);
    assert.ok(result.ignoredFields.includes(ignored), `${toolName}: ${JSON.stringify(result)}`);
    assert.match(result.warning, /未使用/);
    assert.deepEqual(detail, { existingFact: 'preserved' });
  }
});
