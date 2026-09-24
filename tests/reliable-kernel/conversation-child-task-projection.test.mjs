import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import path from 'node:path';
import test from 'node:test';

const require = createRequire(import.meta.url);
const compiledRoot = process.env.LIMCODE_TEST_EXTENSION_ROOT
  ? path.resolve(process.env.LIMCODE_TEST_EXTENSION_ROOT) : path.resolve('dist/extension');
const {
  buildConversationChildTaskProjection, listConversationChildTasks, readConversationChildTask,
  childTaskCard, renderConversationChildTaskCard
} = require(path.join(compiledRoot, 'backend/reliableKernel/conversationChildTaskProjection.js'));
const { estimateJsonTokens } = require(path.join(compiledRoot, 'backend/reliableKernel/modelTokenEstimator.js'));

const NOW = '2026-09-22T00:00:00.000Z';
const LATER = '2026-09-22T00:01:00.000Z';
function fixture() {
  const arrays = ['parentTurns', 'childExecutions', 'parentLinks', 'conversations', 'turns', 'turnLinks',
    'activeTurnLinks', 'intentLinks', 'turnIntents', 'turnIntentRevisions', 'pendingInputs', 'messages',
    'messageTurnLinks', 'messageMemberships', 'messageRevisions', 'currentRevisionLinks', 'terminations',
    'executionLeases', 'executorLinks', 'agentLinks', 'sourceToolCalls', 'answerBridges', 'answerSubmissions',
    'answerPayloads', 'inboxItems', 'inboxPayloadLinks', 'deliveries', 'deliveryInputLinks', 'deliveryIntentLinks',
    'contentObjects', 'contextSegmentSources', 'answerToolCalls', 'answerWaitOperations', 'toolOutcomes', 'deliveryWakes',
    'toolResultArtifacts', 'toolModelResults', 'toolResultMessageRevisions'];
  const facts = Object.fromEntries(arrays.map(key => [key, []]));
  Object.assign(facts, { conversationId: 'root', snapshotRevision: 'facts-revision', conversation: { id: 'root' } });
  facts.parentTurns.push({ id: 'root-turn', conversation_id: 'root', created_at: NOW });
  const bytes = new Map();
  const content = (id, text, contentType = 'text/plain') => {
    facts.contentObjects.push({ id, content_type: contentType, byte_length: BigInt(Buffer.byteLength(text)),
      sha256: id, storage_key: id, created_at: NOW });
    bytes.set(id, Buffer.from(text));
    return id;
  };
  const store = { read: async metadata => {
    assert.ok(bytes.has(metadata.id), `missing immutable CAS ${metadata.id}`);
    return bytes.get(metadata.id);
  } };
  const child = (id = 'worker', parentId, status = 'active') => {
    facts.childExecutions.push({ id, child_conversation_id: `${id}-conversation`, status, created_at: NOW });
    facts.parentLinks.push({ id: `${id}-parent`, child_execution_id: id, source_tool_call_id: `${id}-spawn`,
      parent_turn_id: parentId ? `${parentId}-turn` : 'root-turn', parent_child_execution_id: parentId ?? null });
    facts.conversations.push({ id: `${id}-conversation`, title: 'label only' });
    facts.turns.push({ id: `${id}-turn`, conversation_id: `${id}-conversation`, status: 'active', created_at: NOW });
    facts.turnLinks.push({ id: `${id}-turn-link`, child_execution_id: id, turn_id: `${id}-turn`, turn_seq: 1n });
    facts.activeTurnLinks.push({ id: `${id}-active`, child_execution_id: id, turn_id: `${id}-turn` });
    facts.answerBridges.push({ id: `${id}-bridge`, child_execution_id: id, current_submission_id: null });
    facts.sourceToolCalls.push({ id: `${id}-spawn`, tool_name: 'run_agent' });
  };
  const message = (id, text, { worker = 'worker', sequence = 1, turnId = `${worker}-turn`, role = 'input' } = {}) => {
    facts.messages.push({ id, deleted_at: null });
    facts.messageTurnLinks.push({ id: `${id}-turn-link`, message_id: id, turn_id: turnId, role });
    facts.messageMemberships.push({ id: `${id}-member`, message_id: id,
      conversation_id: `${worker}-conversation`, message_seq: BigInt(sequence) });
    facts.messageRevisions.push({ id: `${id}-revision`, message_id: id, revision_seq: 1n,
      role: 'user', content_object_id: content(`${id}-body`, text), created_at: NOW });
    facts.currentRevisionLinks.push({ id: `${id}-current`, message_id: id, revision_id: `${id}-revision` });
  };
  const project = () => buildConversationChildTaskProjection({ snapshotCommitSeq: '17', snapshot: facts }, store);
  return { facts, child, message, content, project, bytes };
}

test('title只是label；初始任务、当前Turn全部有效输入及UI排队正文从各自事实恢复', async () => {
  const f = fixture(); f.child(); f.message('initial', 'original assignment', { sequence: 1 });
  f.facts.sourceToolCalls[0].tool_name = 'submit_plan';
  f.message('second-input', 'additional input in the same turn', { sequence: 2 });
  f.content('queued-message', JSON.stringify({ role: 'user', parts: [{ text: 'queued UI message' },
    { fileData: { fileUri: 'attachment://a', mimeType: 'text/plain' } }] }), 'application/vnd.limcode.message+json');
  f.content('queued-envelope', JSON.stringify({ version: 1, kind: 'input', messageContentObjectId: 'queued-message',
    guidance: { position: '3', hold: 'paused' } }), 'application/vnd.limcode.turn-intent+json');
  f.facts.turnIntents.push({ id: 'ui-intent', conversation_id: 'worker-conversation', turn_id: null, state: 'queued' });
  f.facts.turnIntentRevisions.push({ id: 'ui-intent-r1', intent_id: 'ui-intent', revision_seq: 1n,
    content_object_id: 'queued-envelope', created_at: LATER });
  const p = await f.project(); const task = p.tasks[0];
  assert.equal(task.initialTask.text, 'original assignment');
  assert.equal(task.initialTask.sourceToolName, 'submit_plan');
  assert.deepEqual(task.currentInputs.map(x => x.text), ['original assignment', 'additional input in the same turn']);
  assert.match(task.queuedInputs[0].text, /^queued UI message/);
  assert.equal(task.queuedInputs[0].hold, 'paused');
  assert.equal(task.queuedInputs[0].contentObjectId, 'queued-message');
  assert.equal(task.queuedInputs[0].content.parts[1].fileData.fileUri, 'attachment://a');
  assert.equal(task.label, 'label only');
});

test('continuation envelope解正文；retry、maintenance及runtime delivery不会伪装业务任务', async () => {
  const f = fixture(); f.child(); f.message('initial', 'do the work');
  f.content('followup', 'real continuation');
  const envelopes = [
    ['continue', { kind: 'continuation', sourceTurnId: 'worker-turn', messageContentObjectId: 'followup' }],
    ['retry', { kind: 'retry', sourceTurnId: 'worker-turn' }],
    ['maintenance', { kind: 'runtime_continuation', sourceTurnId: 'worker-turn', maintenance: { kind: 'manual_context_compression' } }]
  ];
  for (const [id, envelope] of envelopes) {
    f.content(`${id}-body`, JSON.stringify(envelope), 'application/vnd.limcode.turn-intent+json');
    f.facts.turnIntents.push({ id, conversation_id: 'worker-conversation', turn_id: null, state: 'queued' });
    f.facts.turnIntentRevisions.push({ id: `${id}-r1`, intent_id: id, revision_seq: 1n,
      content_object_id: `${id}-body`, created_at: LATER });
  }
  f.content('delivery-body', JSON.stringify({ kind: 'runtime_continuation', sourceTurnId: 'worker-turn' }),
    'application/vnd.limcode.child-runtime-delivery-continuation+json');
  f.facts.turnIntents.push({ id: 'delivery', conversation_id: 'worker-conversation', turn_id: null, state: 'queued' });
  f.facts.turnIntentRevisions.push({ id: 'delivery-r1', intent_id: 'delivery', revision_seq: 1n,
    content_object_id: 'delivery-body', created_at: LATER });
  const task = (await f.project()).tasks[0];
  assert.deepEqual(task.queuedInputs.map(x => x.text), ['real continuation']);
  assert.equal(task.timeline.filter(x => x.classification === 'runtime').length, 3);
});

test('native steer只有已提交Context来源才进入当前任务；可见但未生效Message不能混入', async () => {
  const f = fixture(); f.child(); f.message('initial', 'original');
  for (const [id, applied, state] of [['applied', true, 'delivery_unknown'], ['unapplied', false, 'accepted']]) {
    f.message(id, `${id} steering`, { sequence: 2, role: 'native_steer' });
    f.content(`${id}-envelope`, JSON.stringify({ kind: 'native_steer', conversationId: 'worker-conversation',
      turnId: 'worker-turn', messageId: id, messageRevisionId: `${id}-revision` }), 'application/vnd.limcode.native-steer+json');
    f.facts.pendingInputs.push({ id: `${id}-pending`, turn_id: 'worker-turn', input_kind: 'native_steer',
      content_object_id: `${id}-envelope`, state, position: applied ? 1n : 2n, created_at: LATER });
    if (applied) f.facts.contextSegmentSources.push({ id: 'applied-source', source_kind: 'message_revision', source_id: `${id}-revision` });
  }
  const task = (await f.project()).tasks[0];
  assert.deepEqual(task.currentInputs.map(x => x.text), ['original', 'applied steering']);
  assert.deepEqual(task.queuedInputs.map(x => x.text), ['unapplied steering']);
});

test('初始原文不会被message edit与queued revision覆盖，旧来源明确superseded', async () => {
  const f = fixture(); f.child(); f.message('initial', 'first original');
  f.content('edit', 'edited current input');
  f.facts.messageRevisions.push({ id: 'edit-revision', message_id: 'initial', revision_seq: 2n,
    role: 'user', content_object_id: 'edit', created_at: LATER });
  f.facts.currentRevisionLinks[0].revision_id = 'edit-revision';
  const task = (await f.project()).tasks[0];
  assert.equal(task.initialTask.text, 'first original');
  assert.equal(task.initialTask.state, 'superseded');
  assert.deepEqual(task.currentInputs.map(x => x.text), ['edited current input']);
});

test('task分页可枚举超过32项，tree显式授权；游标跨活动revision可续页而不跨scope/root', async () => {
  const f = fixture();
  for (let index = 0; index < 40; index++) f.child(`worker-${String(index).padStart(2, '0')}`, undefined,
    ['active', 'idle', 'closed'][index % 3]);
  f.child('grandchild', 'worker-00');
  const p = await f.project(); const first = listConversationChildTasks(p);
  assert.ok(first.tasks.length <= 32); assert.equal(first.totalDirect, 40); assert.equal(first.totalDescendants, 1);
  assert.equal(first.omitted, 40 - first.tasks.length);
  assert.equal(first.counts.byStatus.active, 14); assert.equal(first.counts.byStatus.idle, 13); assert.equal(first.counts.byStatus.closed, 13);
  const all = [...first.tasks]; let cursor = first.nextCursor;
  while (cursor) {
    const page = listConversationChildTasks({ ...p, revision: 'changed' }, { cursor });
    assert.ok(estimateJsonTokens(page) <= 2600);
    all.push(...page.tasks); cursor = page.nextCursor;
  }
  assert.equal(new Set(all.map(x => x.childExecutionId)).size, 40);
  assert.throws(() => listConversationChildTasks(p, { scope: 'tree', cursor: first.nextCursor }), /scope_mismatch/);
  assert.throws(() => listConversationChildTasks({ ...p, conversationId: 'another-root' }, { cursor: first.nextCursor }), /scope_mismatch/);
  assert.throws(() => listConversationChildTasks(p, { cursor: 'not!base64' }), /cursor_invalid/);
  assert.throws(() => listConversationChildTasks(p, { limit: 101 }), /limit_invalid/);
  assert.throws(() => readConversationChildTask(p, { childExecutionId: 'grandchild' }), /out_of_scope/);
  assert.equal(readConversationChildTask(p, { childExecutionId: 'grandchild', scope: 'tree' }).task.depth, 2);
});

test('已结束Turn、历史答案、最新答案及delivery handled独立；read全文不按320字截断', async () => {
  const f = fixture(); f.child('worker', undefined, 'idle'); f.message('initial', 'x'.repeat(1400));
  f.facts.activeTurnLinks.length = 0;
  f.facts.terminations.push({ id: 'termination', turn_id: 'worker-turn', terminal_status: 'completed', reason: 'done' });
  for (const [index, id] of ['answer-old', 'answer-new'].entries()) {
    f.content(`${id}-body`, id.repeat(200), 'text/markdown');
    f.facts.answerSubmissions.push({ id, answer_bridge_id: 'worker-bridge', turn_id: 'worker-turn', submission_seq: BigInt(index + 1), interrupted: 0n, created_at: LATER });
    f.facts.answerPayloads.push({ id: `${id}-payload`, submission_id: id, content_object_id: `${id}-body`, title: id });
    f.facts.inboxItems.push({ id: `${id}-inbox`, source_kind: 'answer_submission', source_id: id });
  }
  f.facts.answerBridges[0].current_submission_id = 'answer-new';
  f.facts.deliveries.push({ id: 'old-delivery', inbox_item_id: 'answer-old-inbox', target_conversation_id: 'root', state: 'consumed', phase: 'current_turn' });
  f.facts.deliveryInputLinks.push({ id: 'input-link', delivery_id: 'old-delivery', handled_at: null });
  f.facts.deliveryWakes.push({ id: 'dead-wake', delivery_id: 'old-delivery', state: 'dead_letter', last_error: 'delivery retries exhausted' });
  const p = await f.project(); const task = p.tasks[0];
  assert.equal(task.execution.termination.status, 'completed');
  assert.equal(task.result.latestAnswer.answerId, 'answer-new');
  assert.equal(task.result.deliveries[0].sourceId, 'answer-old');
  assert.equal(task.result.deliveries[0].handledAt, undefined);
  assert.equal(task.result.deliveries[0].wakeState, 'dead_letter');
  assert.equal(task.result.deliveries[0].failureReason, 'delivery retries exhausted');
  assert.equal(childTaskCard(task).initialTask.truncated, true);
  assert.match(renderConversationChildTaskCard(task, { childRef: 'A1' }), /operation=read/);
  assert.doesNotMatch(renderConversationChildTaskCard(task, { childRef: 'A1' }), /initial-body/);
  const first = readConversationChildTask(p, { childExecutionId: 'worker', limit: 1 });
  assert.equal(first.timelineSources[0].text.length, 1400);
  let cursor = first.nextCursor; const answers = new Map();
  while (cursor) {
    const page = readConversationChildTask(p, { childExecutionId: 'worker', limit: 100, cursor });
    for (const source of page.timelineSources) if (source.kind === 'answer_submission') {
      const accumulated = answers.get(source.answerId) ?? '';
      assert.equal(source.textOffset, accumulated.length);
      answers.set(source.answerId, accumulated + source.text);
    }
    cursor = page.nextCursor;
  }
  assert.equal(answers.get('answer-old'), 'answer-old'.repeat(200));
  assert.equal(answers.get('answer-new'), 'answer-new'.repeat(200));
});

test('缺失嵌套CAS metadata和错误envelope fail closed，不用标题冒充正文', async () => {
  const f = fixture(); f.child();
  f.content('bad', JSON.stringify({ kind: 'continuation', messageContentObjectId: 'missing' }), 'application/vnd.limcode.turn-intent+json');
  f.facts.turnIntents.push({ id: 'bad-intent', conversation_id: 'worker-conversation', turn_id: null, state: 'queued' });
  f.facts.turnIntentRevisions.push({ id: 'bad-revision', intent_id: 'bad-intent', revision_seq: 1n, content_object_id: 'bad', created_at: NOW });
  await assert.rejects(f.project(), /Missing snapshot ContentObject missing/);
});

test('超长任务跨预算分页可精确拼回；活动变化不使cursor失效，本页重读位置可恢复', async () => {
  const f = fixture(); f.child();
  const original = '任务正文🌏\n'.repeat(6000);
  f.message('initial', original);
  const p = await f.project(); let cursor; let restored = ''; let pages = 0;
  do {
    const page = readConversationChildTask({ ...p, revision: `live-${pages}` }, { childExecutionId: 'worker', cursor });
    assert.ok(estimateJsonTokens(page) <= 2600);
    assert.ok(page.timelineSources.length > 0);
    const chunk = page.timelineSources[0];
    assert.equal(chunk.textOffset, restored.length);
    assert.equal(chunk.totalCharacters, original.length);
    const reread = readConversationChildTask(p, { childExecutionId: 'worker', cursor: page.rereadCursor });
    assert.equal(reread.timelineSources[0].textOffset, chunk.textOffset);
    assert.equal(reread.timelineSources[0].text,
      original.slice(chunk.textOffset, chunk.textOffset + reread.timelineSources[0].text.length));
    restored += chunk.text; cursor = page.nextCursor; pages++;
    assert.ok(pages < 200);
  } while (cursor);
  assert.ok(pages > 5); assert.equal(restored, original);
  const first = readConversationChildTask(p, { childExecutionId: 'worker' });
  const changed = { ...p, tasks: [{ ...p.tasks[0], timeline: [{ ...p.tasks[0].timeline[0], text: 'changed immutable body' }] }] };
  assert.throws(() => readConversationChildTask(changed, { childExecutionId: 'worker', cursor: first.nextCursor }), /source_changed/);
});

test('同名不同任务不合并，current和queue变化改变单task revision；closed bridge不能续接', async () => {
  const f = fixture(); f.child('worker'); f.child('other');
  f.message('first', 'different A'); f.message('second', 'different B', { worker: 'other' });
  const first = await f.project();
  assert.equal(first.tasks.length, 2); assert.equal(new Set(first.tasks.map(x => x.label)).size, 1);
  assert.deepEqual(new Set(first.tasks.map(x => x.initialTask.text)), new Set(['different A', 'different B']));
  const priorRevision = first.tasks.find(x => x.childExecutionId === 'worker').revision;
  f.message('follow-up', 'a second input', { sequence: 2 });
  f.facts.answerBridges.find(x => x.child_execution_id === 'worker').status = 'closed';
  const changed = (await f.project()).tasks.find(x => x.childExecutionId === 'worker');
  assert.notEqual(changed.revision, priorRevision); assert.equal(changed.resumable, false);
});

test('foreground答案已提交到Context单独可见，不能误称无RuntimeDelivery等于没送达', async () => {
  const f = fixture(); f.child(); f.message('initial', 'work');
  f.content('answer-content', 'answer');
  f.facts.answerSubmissions.push({ id: 'submission', answer_bridge_id: 'worker-bridge', turn_id: 'worker-turn',
    submission_seq: 1n, interrupted: 0n, created_at: NOW });
  f.facts.answerPayloads.push({ id: 'payload', submission_id: 'submission', content_object_id: 'answer-content' });
  f.facts.answerBridges[0].current_submission_id = 'submission';
  f.facts.answerToolCalls.push({ id: 'worker-spawn', tool_name: 'run_agent' });
  f.content('result-artifact', JSON.stringify({ detail: { submissionId: 'submission' } }), 'application/json');
  f.facts.toolResultArtifacts.push({ id: 'artifact', tool_call_id: 'worker-spawn', content_object_id: 'result-artifact' });
  f.facts.toolModelResults.push({ id: 'model-result', tool_call_id: 'worker-spawn' });
  f.facts.contextSegmentSources.push({ id: 'context', source_kind: 'tool_model_result', source_id: 'model-result' });
  const result = (await f.project()).tasks[0].result;
  assert.deepEqual(result.deliveries, []);
  assert.deepEqual(result.handling, [{ answerId: 'submission', via: 'tool_result', toolCallId: 'worker-spawn', contextCommitted: true }]);
});

test('同毫秒不同Turn以turn_seq判最新；runtime maintenance继承最近续发任务，不回退初始任务', async () => {
  const f = fixture(); f.child(); f.message('initial', 'first task');
  f.facts.turns.push({ id: 'zzz-followup', conversation_id: 'worker-conversation', status: 'terminated', created_at: NOW });
  f.facts.turns.push({ id: 'aaa-maintenance', conversation_id: 'worker-conversation', status: 'active', created_at: NOW });
  f.facts.turnLinks.push({ id: 'followup-link', child_execution_id: 'worker', turn_id: 'zzz-followup', turn_seq: 2n });
  f.facts.turnLinks.push({ id: 'maintenance-link', child_execution_id: 'worker', turn_id: 'aaa-maintenance', turn_seq: 3n });
  f.facts.activeTurnLinks[0].turn_id = 'aaa-maintenance';
  f.message('followup-input', 'latest business task', { turnId: 'zzz-followup', sequence: 2 });
  f.content('maintenance-body', JSON.stringify({ kind: 'retry', sourceTurnId: 'zzz-followup',
    runtimeMaintenance: { kind: 'manual_context_compression' } }), 'application/vnd.limcode.turn-intent+json');
  f.facts.turnIntents.push({ id: 'maintenance-intent', conversation_id: 'worker-conversation', turn_id: 'aaa-maintenance', state: 'admitted' });
  f.facts.turnIntentRevisions.push({ id: 'maintenance-revision', intent_id: 'maintenance-intent', revision_seq: 1n,
    content_object_id: 'maintenance-body', created_at: NOW });
  f.facts.terminations.push({ id: 'previous-terminal', turn_id: 'zzz-followup', terminal_status: 'failed', reason: 'old failure' });
  const task = (await f.project()).tasks[0];
  assert.equal(task.execution.latestTurnId, 'aaa-maintenance');
  assert.equal(task.execution.termination, undefined);
  assert.deepEqual(task.currentInputs.map(x => x.text), ['latest business task']);
  assert.equal(task.currentInputs[0].turnId, 'zzz-followup');
});
