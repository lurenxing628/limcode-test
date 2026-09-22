import assert from 'node:assert/strict';
import path from 'node:path';
import { createRequire } from 'node:module';
import test from 'node:test';

const require = createRequire(import.meta.url);
const extensionDist = process.env.LIMCODE_EXTENSION_DIST
  ? path.resolve(process.env.LIMCODE_EXTENSION_DIST) : path.resolve('dist/extension');
const { ReliableChildAgentCoordinator } = require(path.join(extensionDist, 'backend/reliableKernel/childAgentCoordinator.js'));
const { ChildExecutionControlPlane } = require(path.join(extensionDist, 'backend/reliableKernel/childExecution.js'));

function source(id, text, state = 'effective') {
  return { id, kind: 'turn_intent_revision', classification: 'task', state, text,
    contentObjectId: `content-${id}`, contentType: 'text/plain', sequence: '1', createdAt: '2026-09-22T00:00:00.000Z' };
}

function task(index, extra = {}) {
  const initialTask = source(`initial-${index}`, `original assignment ${index}`);
  const current = source(`current-${index}`, `current assignment ${index}`);
  const queued = source(`queued-${index}`, `queued follow-up ${index}`, 'queued');
  return { childExecutionId: `child-${index}`, answerBridgeId: `bridge-${index}`,
    parentConversationId: 'parent-conversation', conversationId: `child-conversation-${index}`,
    depth: 1, status: 'active', label: 'Same display label', createdAt: '2026-09-22T00:00:00.000Z',
    revision: `revision-${index}`, initialTask, currentInputs: [current], queuedInputs: [queued],
    timeline: [initialTask, current, queued], execution: { activeTurnId: `active-${index}` },
    result: { deliveries: [] }, ...extra };
}

function fixture(initialTasks = [task(1)]) {
  const events = { spawns: [], sends: [], interrupts: [], settlements: [], observations: 0 };
  const listeners = new Set();
  let tasks = initialTasks;
  let revision = 'projection-1';
  const database = {
    hostBootId: 'task-tools-host',
    onCommit(listener) { listeners.add(listener); return () => listeners.delete(listener); },
    async snapshot(reads) { return { snapshot: reads.map(read => {
      if (read.domain === 'Turn') return { id: read.id, conversation_id: 'parent-conversation', status: 'active' };
      if (read.domain === 'ToolCall') return { id: read.id, turn_id: 'parent-turn' };
      return read.kind === 'list' ? [] : null;
    }) }; }
  };
  const coordinator = new ReliableChildAgentCoordinator({ database,
    effects: { async settleWithoutEffect(input) {
      events.settlements.push(input);
      return { status: input.status, terminal: { status: input.status, detail: input.detail } };
    } },
    children: {
      async spawn(input) { events.spawns.push(input); throw new Error('Unexpected child spawn'); },
      async readConversationTaskProjection(conversationId) {
        assert.equal(conversationId, 'parent-conversation');
        events.observations += 1;
        return { conversationId, revision, snapshotCommitSeq: '42', tasks };
      },
      async readExecutionSnapshot(childExecutionId) {
        const value = tasks.find(item => item.childExecutionId === childExecutionId);
        assert.ok(value);
        return { childExecution: { id: value.childExecutionId, child_conversation_id: value.conversationId, status: value.status },
          answerBridge: { id: value.answerBridgeId, status: 'open' }, activeTurn: { id: value.execution.activeTurnId, status: 'active' } };
      },
      async send(input) { events.sends.push(input); return { turnIntentId: 'new-intent' }; },
      async finalizeWaitSettlement(toolCallId) { return { toolCallId, status: 'succeeded' }; }
    },
    answers: { async readCurrent() { return { status: 'running' }; } }
  });
  coordinator.triggerRecoveryPass = () => {};
  coordinator.interruptSubtree = async input => {
    events.interrupts.push(input);
    return { rootChildExecutionId: input.childExecutionId, activeTurnIds: [], cancelledIntentIds: [] };
  };
  let calls = 0;
  return { coordinator, events, listeners,
    replaceTasks(next) { tasks = next; revision = 'projection-2'; for (const listener of [...listeners]) listener(); },
    call(args, signal, toolName = 'run_agent') {
      return coordinator.dispatch({ turnId: 'parent-turn', modelRequestId: 'parent-request',
        toolCallId: `call-${++calls}`, toolName, arguments: args }, signal);
    }
  };
}

test('missing operation, missing spawn identity and malformed send fail before child creation', async () => {
  const f = fixture();
  for (const args of [
    { prompt: 'accidental duplicate' }, { mode: 'run', prompt: 'old implicit spawn' },
    { operation: 'spawn', prompt: 'missing label' },
    { operation: 'spawn', taskName: 'label', prompt: 'task', answerBridgeId: 'bridge-1' },
    { operation: 'spawn', taskName: 'label', prompt: 'task', agent: { id: 'worker' } },
    { operation: 'send', prompt: 'missing ref' },
    { operation: 'send', answerBridgeId: 'unknown-bridge', prompt: 'never fall back to spawn' }
  ]) await assert.rejects(f.call(args));
  assert.deepEqual(f.events.spawns, []);
  assert.deepEqual(f.events.sends, []);
  assert.deepEqual(f.events.settlements, []);
});

test('canonical and inherited references never authorize unrelated or sibling task operations', async () => {
  const f = fixture();
  for (const operation of ['send', 'read', 'wait', 'interrupt_subtree']) {
    await assert.rejects(f.call({ operation, answerBridgeId: 'other-conversation-canonical-bridge',
      ...(operation === 'send' ? { prompt: 'unrelated task' } : {}) }), /outside.*parent lineage/);
  }
  await assert.rejects(f.call({ answerBridgeId: 'inherited-fork-bridge' }, undefined, 'read_agent_answer'), /outside.*parent lineage/);
  assert.deepEqual(f.events.spawns, []);
  assert.deepEqual(f.events.sends, []);
  assert.deepEqual(f.events.interrupts, []);
});

test('verified descendants are readable only with tree scope and remain outside direct control', async () => {
  const f = fixture([task(1), task(2, { depth: 2, parentConversationId: 'child-conversation-1' })]);
  await assert.rejects(f.call({ operation: 'read', answerBridgeId: 'bridge-2' }), /outside.*direct/);
  const result = await f.call({ operation: 'read', answerBridgeId: 'bridge-2', scope: 'tree' });
  assert.equal(result.detail.task.answerBridgeId, 'bridge-2');
  assert.equal(result.detail.timelineSources[0].text, 'original assignment 2');
  for (const operation of ['send', 'interrupt_subtree']) {
    await assert.rejects(f.call({ operation, answerBridgeId: 'bridge-2',
      ...(operation === 'send' ? { prompt: 'descendant write' } : {}) }), /outside.*direct/);
  }
  assert.deepEqual(f.events.sends, []);
  assert.deepEqual(f.events.interrupts, []);
});

test('list pagination recovers more than 32 same-label tasks and read preserves all assignments', async () => {
  // Match the committed projection's stable ordering; equal timestamps sort by canonical id.
  const expected = Array.from({ length: 70 }, (_, index) => task(index + 1))
    .sort((a, b) => a.createdAt.localeCompare(b.createdAt) || a.childExecutionId.localeCompare(b.childExecutionId));
  const f = fixture(expected);
  const collected = [];
  const seenCursors = new Set();
  let cursor;
  for (;;) {
    const page = (await f.call({ operation: 'list', limit: 40, ...(cursor ? { cursor } : {}) })).detail;
    assert.ok(page.tasks.length > 0 && page.tasks.length <= 40, 'limit caps a page; the token budget may shorten it');
    assert.equal(page.totalDirect, 70);
    assert.equal(page.shown, page.tasks.length);
    assert.equal(typeof page.rereadCursor, 'string');
    assert.ok(page.rereadCursor.length > 0);
    const reread = (await f.call({ operation: 'list', limit: 40, cursor: page.rereadCursor })).detail;
    assert.deepEqual(reread.tasks, page.tasks, 'the page supplies a valid cursor for an exact reread');
    collected.push(...page.tasks);
    assert.ok(collected.length <= expected.length, 'pagination cannot duplicate tasks or continue indefinitely');
    assert.equal(page.omitted, expected.length - collected.length);
    if (!page.nextCursor) {
      assert.equal(collected.length, expected.length, 'the final page must include every committed task');
      break;
    }
    assert.equal(typeof page.nextCursor, 'string');
    assert.ok(page.nextCursor.length > 0);
    assert.ok(!seenCursors.has(page.nextCursor), 'the next cursor must make progress');
    seenCursors.add(page.nextCursor);
    cursor = page.nextCursor;
  }
  assert.ok(seenCursors.size > 0, 'more than one bounded page is required');
  assert.equal(new Set(collected.map(value => value.childExecutionId)).size, 70);
  assert.deepEqual(collected.map(value => ({ childExecutionId: value.childExecutionId,
    answerBridgeId: value.answerBridgeId, label: value.label, preview: value.taskPreview })),
  expected.map(value => ({ childExecutionId: value.childExecutionId, answerBridgeId: value.answerBridgeId,
    label: value.label, preview: value.currentInputs.at(-1).text })));
  const read = (await f.call({ operation: 'read', answerBridgeId: 'bridge-1', limit: 100 })).detail;
  assert.deepEqual(read.timelineSources.map(value => value.text),
    ['original assignment 1', 'current assignment 1', 'queued follow-up 1']);
  assert.deepEqual(f.events.spawns, []);
  assert.deepEqual(f.events.sends, []);
});

test('send appends to the validated existing child and never creates another execution', async () => {
  const f = fixture();
  await f.call({ operation: 'send', answerBridgeId: 'bridge-1', prompt: 'verify the existing findings' });
  assert.equal(f.events.sends.length, 1);
  assert.equal(f.events.sends[0].childExecutionId, 'child-1');
  assert.equal(f.events.sends[0].mode, 'queue_next_turn');
  assert.match(f.events.sends[0].content, /^verify the existing findings/);
  assert.deepEqual(f.events.spawns, []);
});

test('wait supports multiple validated children and returns changed facts without sending work', async () => {
  const f = fixture([task(1), task(2)]);
  const waiting = f.call({ operation: 'wait', answerBridgeIds: ['bridge-1', 'bridge-2'], timeoutMs: 500 });
  const timer = setTimeout(() => f.replaceTasks([task(1), task(2, { revision: 'changed-2', status: 'idle', queuedInputs: [] })]), 20);
  try {
    const result = (await waiting).detail;
    assert.equal(result.changed, true);
    assert.equal(result.timedOut, false);
    assert.deepEqual(result.tasks.map(value => value.answerBridgeId), ['bridge-1', 'bridge-2']);
    assert.equal(result.tasks[1].status, 'idle');
    assert.equal(f.listeners.size, 0);
    assert.deepEqual(f.events.spawns, []);
    assert.deepEqual(f.events.sends, []);
    assert.deepEqual(f.events.interrupts, []);
  } finally { clearTimeout(timer); }
});

test('wait validates bounds and reference forms, and timeout or parent abort never cancels a child', async () => {
  const f = fixture();
  for (const args of [
    { answerBridgeId: 'bridge-1', answerBridgeIds: ['bridge-1'] },
    { answerBridgeIds: [] }, { answerBridgeIds: ['bridge-1', 'bridge-1'] },
    { answerBridgeId: 'bridge-1', timeoutMs: 60_001 }
  ]) await assert.rejects(f.call({ operation: 'wait', ...args }));
  const timeout = (await f.call({ operation: 'wait', answerBridgeId: 'bridge-1', timeoutMs: 5 })).detail;
  assert.equal(timeout.timedOut, true);
  const controller = new AbortController();
  const waiting = f.call({ operation: 'wait', answerBridgeId: 'bridge-1', timeoutMs: 500 }, controller.signal);
  const timer = setTimeout(() => controller.abort(new Error('parent stopped waiting')), 10);
  try { await assert.rejects(waiting, /parent stopped waiting/); } finally { clearTimeout(timer); }
  assert.equal(f.listeners.size, 0);
  assert.deepEqual(f.events.spawns, []);
  assert.deepEqual(f.events.sends, []);
  assert.deepEqual(f.events.interrupts, []);
});

test('internal canonical send enforces the original parent conversation before publishing content', async () => {
  const value = Object.create(ChildExecutionControlPlane.prototype);
  value.findSendReplay = async () => null;
  value.readExecutionSnapshot = async () => ({ childExecution: { status: 'idle' }, answerBridge: { status: 'open' },
    parentLink: { id: 'parent-link', parent_turn_id: 'original-parent-turn' } });
  value.readSpawnParent = async () => ({ conversation: { id: 'attacker-conversation' },
    turn: { status: 'active' }, termination: null, lease: {}, toolCall: { status: 'pending' }, toolExecution: { status: 'pending' } });
  value.requireExisting = async () => ({ id: 'original-parent-turn', conversation_id: 'original-parent-conversation' });
  value.contentStore = { prepare() { assert.fail('must not publish unauthorized task content'); } };
  await assert.rejects(value.send({ sourceKey: 'canonical-send', sourceToolCallId: 'canonical-call',
    childExecutionId: 'known-child', mode: 'queue_next_turn', content: 'unauthorized', completionPolicy: 'background' }), /outside.*parent lineage/);
});
