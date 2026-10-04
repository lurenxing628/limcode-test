import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import path from 'node:path';
import test from 'node:test';

const require = createRequire(import.meta.url);
const load = name => require(path.resolve(process.env.LIMCODE_TEST_EXTENSION_ROOT ?? 'dist/extension', 'backend/reliableKernel', name));
const handleState = load('conversationContextHandleState.js');
const { ContextSequenceControlPlane } = load('contextSequence.js');
const NOW = '2026-10-04T00:00:00.000Z';
const CONVERSATION = 'conversation';
const HEAD = { id: 'head', conversation_id: CONVERSATION, root_id: 'root-before', updated_at: NOW };
const metadata = id => ({ id, content_type: 'application/json', sha256: 'a'.repeat(64),
  byte_length: 2n, storage_key: id, created_at: NOW });
const rootStep = steps => steps.find(step => step.domain === 'ContextSequenceRoot' && step.kind === 'insert' && step.allocateSequence);
const headStep = steps => steps.find(step => step.domain === 'ConversationContextHeadLink' && step.kind === 'update');

function transitionSpy(t) {
  const original = handleState.prepareContextHandleHeadTransition;
  const calls = [];
  handleState.prepareContextHandleHeadTransition = async input => {
    const marker = { kind: 'assert', domain: 'ConversationContextHandleState', id: `scope-${calls.length}`, where: {} };
    const state = { id: 'state', context_root_id: input.nextRootId, revision: BigInt(calls.length + 1) };
    calls.push({ input, marker, state });
    return { steps: [marker], state };
  };
  t.after(() => { handleState.prepareContextHandleHeadTransition = original; });
  return calls;
}

function fixture() {
  const transactions = [];
  const database = {
    async transaction(steps) {
      transactions.push(steps);
      return { commitSeq: '1', allocatedSequences: steps.filter(step => step.kind === 'insert' && step.allocateSequence)
        .map(step => ({ domain: step.domain, id: step.row.id, column: step.allocateSequence.column, value: '1' })) };
    }
  };
  const context = new ContextSequenceControlPlane(database, {}, { now: () => NOW });
  context.getHead = async () => HEAD;
  context.readBaseShape = async (_conversationId, rootId) => ({
    root: { id: rootId }, rootId, rootNodeId: 'node-before', tailNodeId: null,
    tailSegmentCount: 0n, segmentCount: 1n, estimatedTokens: 4n, compression: false
  });
  context.readOccurrence = async () => null;
  return { context, database, transactions };
}

function assertAtomicOrder(steps, marker, shape) {
  const root = rootStep(steps);
  assert.ok(root, 'the root is inserted in this writer transaction');
  if (shape) assert.deepEqual(shape, { rootNodeId: root.row.root_node_id, tailNodeId: root.row.tail_node_id,
    tailSegmentCount: root.row.tail_segment_count, segmentCount: root.row.segment_count });
  assert.ok(steps.indexOf(marker) > steps.indexOf(root), 'the snapshot references an already inserted root');
  assert.ok(steps.indexOf(marker) < steps.indexOf(headStep(steps)), 'the same transaction publishes snapshot and head');
}

test('message append publishes its exact occurrence once with the root and head fence', async t => {
  const calls = transitionSpy(t);
  const { context } = fixture();
  const occurrence = { kind: 'message', modelRequestId: 'request', content: '[{"type":"text","text":"P3520"}]' };
  const plan = await context.prepareMessageAppendMutation({ conversationId: CONVERSATION,
    messageRevisionId: 'revision', contentObjectId: 'body', contentByteLength: 3n,
    contentEstimatedTokens: 2, handleOccurrence: occurrence });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].input.occurrence, occurrence);
  assert.equal(calls[0].input.previousRootId, HEAD.root_id);
  assert.equal(calls[0].input.mode, 'append');
  assertAtomicOrder(plan.steps, calls[0].marker, calls[0].input.rootShape);
  assert.ok(plan.steps.some(step => step.kind === 'assert' && step.domain === 'ConversationContextHeadLink'
    && step.where.root_id === HEAD.root_id));
});

test('ordered tool results publish one snapshot per immutable prefix in the existing single transaction', async t => {
  const calls = transitionSpy(t);
  const { context, database, transactions } = fixture();
  const tables = new Map([
    ['Conversation', [{ id: CONVERSATION }]],
    ['Turn', [{ id: 'turn', conversation_id: CONVERSATION }]],
    ['ToolCall', [1, 2].map(index => ({ id: `call-${index}`, turn_id: 'turn', call_seq: BigInt(index),
      arguments_object_id: `args-${index}`, tool_name: 'execute_command' }))],
    ['ToolModelResult', [1, 2].map(index => ({ id: `result-${index}`, tool_call_id: `call-${index}`,
      message_revision_id: `revision-${index}` }))],
    ['MessageRevision', [1, 2].map(index => ({ id: `revision-${index}`, content_object_id: `body-${index}` }))],
    ['ContentObject', [1, 2].flatMap(index => [metadata(`args-${index}`), metadata(`body-${index}`)])]
  ]);
  database.snapshot = async reads => ({ snapshot: reads.map(read => {
    const rows = tables.get(read.domain) ?? [];
    return read.kind === 'get' ? rows.find(row => row.id === read.id) ?? null
      : rows.filter(row => Object.entries(read.where ?? {}).every(([key, value]) => row[key] === value));
  }) });
  context.contentStore = {
    async readMany(rows) { return rows.map(() => Buffer.from('{}')); },
    async prepareBatch(_database, bodies) { return bodies.map((_body, index) => ({ metadata: metadata(`pair-${index}`) })); }
  };
  const result = await context.appendToolPairsInOrderBatch({ conversationId: CONVERSATION,
    pairs: [1, 2].map(index => ({ toolCallId: `call-${index}`, toolModelResultId: `result-${index}` })) });
  assert.equal(result.transactionCount, 1);
  assert.equal(transactions.length, 1);
  assert.equal(calls.length, 2);
  assert.equal(calls[0].input.previousRootId, null);
  assert.equal(calls[1].input.previousRootId, calls[0].input.nextRootId);
  assert.equal(calls[1].input.current, calls[0].state, 'second snapshot starts from the planned first prefix');
  assert.deepEqual(calls.map(call => call.input.occurrences), [1, 2].map(index => [
    { kind: 'tool_call', toolCallId: `call-${index}` },
    { kind: 'tool_result', toolCallId: `call-${index}`, toolModelResultId: `result-${index}` }
  ]));
  const steps = transactions[0];
  for (const call of calls) {
    const rootIndex = steps.findIndex(step => step.kind === 'insert' && step.domain === 'ContextSequenceRoot'
      && step.row.id === call.input.nextRootId);
    assert.ok(rootIndex >= 0);
    const root = steps[rootIndex].row;
    assert.deepEqual(call.input.rootShape, { rootNodeId: root.root_node_id, tailNodeId: root.tail_node_id,
      tailSegmentCount: root.tail_segment_count, segmentCount: root.segment_count });
    assert.equal(steps[rootIndex + 1], call.marker);
  }
  const head = steps.find(step => step.kind === 'insert' && step.domain === 'ConversationContextHeadLink');
  assert.equal(head.row.root_id, calls[1].input.nextRootId);
  assert.ok(steps.indexOf(head) > steps.indexOf(calls[1].marker));
});
