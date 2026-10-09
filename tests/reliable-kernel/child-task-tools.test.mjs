import assert from 'node:assert/strict';
import path from 'node:path';
import { createRequire } from 'node:module';
import test from 'node:test';

const require = createRequire(import.meta.url);
const extensionDist = process.env.LIMCODE_EXTENSION_DIST
  ? path.resolve(process.env.LIMCODE_EXTENSION_DIST) : path.resolve('dist/extension');
const { ReliableChildAgentCoordinator, validateRunAgentToolArguments, validateReadAgentAnswerToolArguments, agentToolArgumentMetadata } = require(path.join(extensionDist, 'backend/reliableKernel/childAgentCoordinator.js'));
const { ChildExecutionControlPlane } = require(path.join(extensionDist, 'backend/reliableKernel/childExecution.js'));
const { runAgentTool } = require(path.join(extensionDist, 'backend/world/modules/tools/definitions/runAgent/index.js'));

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
    resumable: true, initialTask, currentInputs: [current], queuedInputs: [queued],
    timeline: [initialTask, current, queued], execution: { activeTurnId: `active-${index}` },
    result: { deliveries: [], handling: [] }, ...extra };
}

function fixture(initialTasks = [task(1)]) {
  const events = { spawns: [], sends: [], interrupts: [], settlements: [], observations: 0 };
  const listeners = new Set();
  let tasks = initialTasks;
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
        return { conversationId, snapshotCommitSeq: '42', tasks };
      },
      async readExecutionSnapshot(childExecutionId) {
        const value = tasks.find(item => item.childExecutionId === childExecutionId);
        assert.ok(value);
        return { childExecution: { id: value.childExecutionId, child_conversation_id: value.conversationId, status: value.status },
          answerBridge: { id: value.answerBridgeId, status: 'open' }, activeTurn: { id: value.execution.activeTurnId, status: 'active' } };
      },
      async send(input) { events.sends.push(input); return { turnIntentId: 'new-intent', mode: input.mode,
        affectedTurnId: tasks.find(task => task.childExecutionId === input.childExecutionId)?.execution.activeTurnId }; },
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
    replaceTasks(next) { tasks = next; for (const listener of [...listeners]) listener(); },
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
    { operation: 'send', prompt: 'missing ref' },
    { operation: 'send', answerBridgeId: 'unknown-bridge', prompt: 'never fall back to spawn' }
  ]) await assert.rejects(f.call(args));
  assert.deepEqual(f.events.spawns, []);
  assert.deepEqual(f.events.sends, []);
  assert.deepEqual(f.events.settlements, []);
});

test('explicit readonly operations accept empty unrelated placeholders without sending or spawning work', async () => {
  const f = fixture();
  for (const empty of [null, '', [], {}]) {
    const result = await f.call({ operation: 'list', prompt: empty, taskName: empty, agent: empty,
      skills: empty, answerBridgeId: empty, answerBridgeIds: empty, forkTurns: empty,
      foregroundWaitMs: empty, interrupt: empty, cursor: empty, scope: empty, trackingNote: 'harmless extra' });
    assert.equal(result.detail.tasks.length, 1);
    assert.equal(result.detail.operation, 'list');
  }
  const read = await f.call({ operation: 'read', answerBridgeId: 'bridge-1', cursor: null, skills: [], prompt: '' });
  assert.equal(read.detail.task.answerBridgeId, 'bridge-1');
  const wait = await f.call({ operation: 'wait', answerBridgeId: 'bridge-1', answerBridgeIds: [], timeoutMs: 0, agent: {} });
  assert.equal(wait.detail.operation, 'wait');
  assert.deepEqual(f.events.spawns, []);
  assert.deepEqual(f.events.sends, []);
  assert.deepEqual(f.events.interrupts, []);
  assert.equal(f.listeners.size, 0);
});

test('explicit readonly operation ignores nonempty cross-operation arguments without assigning work', async () => {
  const f = fixture();
  for (const extra of [{ prompt: 'assign new work' }, { agent: { type: 'worker' } },
    { skills: ['review'] }, { foregroundWaitMs: 0 }, { interrupt: false }, { mode: 'spawn' }]) {
    const raw = { operation: 'list', ...extra };
    assert.equal((await f.call(raw)).detail.operation, 'list');
    assert.ok(agentToolArgumentMetadata('run_agent', raw).ignoredFields.includes(Object.keys(extra)[0]));
  }
  assert.equal(f.events.observations, 6);
  assert.deepEqual(f.events.spawns, []);
  assert.deepEqual(f.events.sends, []);
  assert.deepEqual(f.events.interrupts, []);
  assert.equal(f.events.settlements.length, 6);
});

test('run-agent normalization keeps explicit zero and false without changing caller-owned arguments', () => {
  const send = Object.freeze({ operation: 'send', answerBridgeId: ' bridge-1 ', prompt: ' task ', interrupt: false,
    foregroundWaitMs: 0, skills: null, unknownNote: 'ignored' });
  assert.deepEqual(validateRunAgentToolArguments(send), { operation: 'send', answerBridgeId: 'bridge-1', prompt: 'task', interrupt: false, foregroundWaitMs: 0 });
  assert.equal(send.answerBridgeId, ' bridge-1 ');
  const spawn = Object.freeze({ operation: 'spawn', taskName: ' review ', prompt: ' complete review ', agent: Object.freeze({ type: ' worker ', note: 'ignored' }),
    skills: Object.freeze(['review', ' review ']), forkTurns: '2', foregroundWaitMs: 0 });
  assert.deepEqual(validateRunAgentToolArguments(spawn), { operation: 'spawn', taskName: 'review', prompt: 'complete review', agent: { type: 'worker' },
    skills: ['review'], forkTurns: '2', foregroundWaitMs: 0 });
  assert.equal(spawn.skills.length, 2);
  assert.deepEqual(validateRunAgentToolArguments({ operation: 'wait', answerBridgeId: 'a', answerBridgeIds: ['b'] }), { operation: 'wait', answerBridgeId: 'a' });
  assert.deepEqual(agentToolArgumentMetadata('run_agent', { operation: 'wait', answerBridgeId: 'a', answerBridgeIds: ['b'] }).ignoredFields, ['childRefs']);
  assert.deepEqual(validateRunAgentToolArguments({ operation: 'spawn', taskName: 'label', prompt: 'task', agent: { id: 'worker' } }),
    { operation: 'spawn', taskName: 'label', prompt: 'task', agent: {} });
  assert.deepEqual(agentToolArgumentMetadata('run_agent', { operation: 'spawn', taskName: 'label', prompt: 'task', agent: { id: 'worker' } }).ignoredFields, ['agent.id']);
  for (const invalid of [{ operation: 'wait', answerBridgeId: false, answerBridgeIds: ['b'] },
    { operation: 'send', answerBridgeId: 'a', prompt: 'task', interrupt: 'false' },
    { operation: 'spawn', taskName: 'label', prompt: 'task', agent: { type: false } }]) {
    assert.throws(() => validateRunAgentToolArguments(invalid), error => error.name === 'ToolArgumentError');
  }
});

test('reading an answer ignores unrelated operation controls and never assigns or interrupts work', async () => {
  const f = fixture();
  const answer = await f.call({ answerBridgeId: 'bridge-1', scope: null, prompt: '', unknownNote: 'ignored' }, undefined, 'read_agent_answer');
  assert.equal(answer.detail.status, 'running');
  for (const extra of [{ operation: 'send' }, { mode: 'spawn' }, { prompt: 'new assignment' }, { interrupt: true }]) {
    const raw = { answerBridgeId: 'bridge-1', ...extra };
    assert.equal((await f.call(raw, undefined, 'read_agent_answer')).detail.status, 'running');
    assert.ok(agentToolArgumentMetadata('read_agent_answer', raw).ignoredFields.includes(Object.keys(extra)[0]));
  }
  assert.deepEqual(f.events.spawns, []);
  assert.deepEqual(f.events.sends, []);
  assert.deepEqual(f.events.interrupts, []);
});

test('agent numeric budgets accept integer strings and clamp without changing targets or zero polling', () => {
  const raw = Object.freeze({ operation: 'wait', answerBridgeId: 'bridge-1', timeoutMs: '120000', foregroundWaitMs: false, prompt: 'unused' });
  assert.deepEqual(validateRunAgentToolArguments(raw), { operation: 'wait', answerBridgeId: 'bridge-1', timeoutMs: 60_000 });
  assert.deepEqual(agentToolArgumentMetadata('run_agent', raw).adjustedArguments, { timeoutMs: 60_000 });
  assert.equal(raw.timeoutMs, '120000');
  assert.equal(validateRunAgentToolArguments({ operation: 'wait', answerBridgeId: 'bridge-1', timeoutMs: 0 }).timeoutMs, 0);
  assert.equal(validateRunAgentToolArguments({ operation: 'list', limit: '0' }).limit, 1);
  assert.equal(validateRunAgentToolArguments({ operation: 'list', limit: 1000 }).limit, 100);
  assert.equal(validateRunAgentToolArguments({ operation: 'spawn', taskName: 'label', prompt: 'task', foregroundWaitMs: 100_000_000 }).foregroundWaitMs, 86_400_000);
  for (const timeoutMs of [false, -1, 1.5, '1.5']) assert.throws(() => validateRunAgentToolArguments({ operation: 'wait', answerBridgeId: 'bridge-1', timeoutMs }), { name: 'ToolArgumentError' });
  assert.deepEqual(validateReadAgentAnswerToolArguments({ answerBridgeId: 'bridge-1', operation: 'spawn', interrupt: true, prompt: 'ignored' }), { answerBridgeId: 'bridge-1' });
});

test('run-agent scheduling and summary consume the selected trimmed operation', () => {
  const raw = Object.freeze({ operation: ' interrupt_subtree ', answerBridgeId: 'bridge-1', scheduling: 'parallel', prompt: 'unused' });
  assert.deepEqual(runAgentTool.scheduling(raw), { mode: 'serial', reason: 'interrupt_subtree' });
  assert.equal(runAgentTool.summary(raw, {}), 'Interrupt Agent · bridge-1');
  assert.equal(raw.operation, ' interrupt_subtree ');
  assert.equal(runAgentTool.summary({ operation: ' send ', answerBridgeId: 'bridge-1', prompt: 'continue', agent: { type: 'unused-type' }, skills: ['unused-skill'] }, {}), 'Run Agent · continue');
});

test('existing child work replays or resumes durable facts before new argument validation', async () => {
  const f = fixture();
  f.coordinator.list = async domain => domain === 'Operation' ? [{ owner_id: 'existing-child', status: 'waiting_answer' }] : [];
  const replay = await f.call({ mode: 'old-spawn', agent: { id: 'old-agent' }, prompt: 'original work' });
  assert.equal(replay.status, 'succeeded');
  f.coordinator.dependencies.children.finalizeWaitSettlement = async () => null;
  const pending = await f.call({ mode: 'old-spawn', prompt: 'original work' });
  assert.equal(pending.reason, 'awaiting_child');
  assert.equal(pending.resumeKey, 'existing-child');
  assert.deepEqual(f.events.spawns, []);
  assert.deepEqual(f.events.sends, []);
  assert.deepEqual(f.events.interrupts, []);
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
  const timer = setTimeout(() => f.replaceTasks([task(1), task(2, { status: 'idle', queuedInputs: [] })]), 20);
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

test('wait selects a single target before array scaffolding and timeout or parent abort never cancels a child', async () => {
  const f = fixture();
  const single = (await f.call({ operation: 'wait', answerBridgeId: 'bridge-1', answerBridgeIds: ['unrelated-child'], timeoutMs: 0 })).detail;
  assert.deepEqual(single.tasks.map(task => task.answerBridgeId), ['bridge-1']);
  assert.equal(f.events.observations, 1);
  for (const args of [
    { answerBridgeIds: [] }, { answerBridgeIds: ['bridge-1', 'bridge-1'] },
    { answerBridgeIds: Array.from({ length: 33 }, (_, i) => `bridge-${i}`) },
    { answerBridgeId: false, answerBridgeIds: ['bridge-1'] },
    { answerBridgeId: 'bridge-1', timeoutMs: false }
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

test('wait ignores unrelated task commits and detects same-status source identity changes', async () => {
  const initial = task(1); const f = fixture([initial, task(2)]);
  const waiting = f.call({ operation: 'wait', answerBridgeId: 'bridge-1', timeoutMs: 5000 });
  const observe = async count => {
    for (let tries = 0; tries < 1000 && f.events.observations < count; tries++) await new Promise(resolve => setImmediate(resolve));
    assert.ok(f.events.observations >= count, `wait observed snapshot ${count}`);
  };
  await observe(1);
  f.replaceTasks([structuredClone(initial), task(2, { label: 'unrelated change' })]);
  await observe(2);
  // Drain the snapshot continuation: a false positive would already have settled and unsubscribed.
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(f.events.settlements.length, 0);
  assert.equal(f.listeners.size, 1);
  const changed = structuredClone(initial);
  changed.timeline[1].contentObjectId = 'new-immutable-body-with-same-visible-text';
  f.replaceTasks([changed, task(2, { label: 'unrelated change' })]);
  const result = (await waiting).detail;
  assert.equal(result.changed, true);
  assert.equal(result.timedOut, false);
  assert.equal(result.tasks[0].status, 'active');
  assert.equal(f.listeners.size, 0);
});
