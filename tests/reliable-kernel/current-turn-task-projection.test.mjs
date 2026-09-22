import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import path from 'node:path';
import test from 'node:test';

const require = createRequire(import.meta.url);
const compiledRoot = process.env.LIMCODE_TEST_EXTENSION_ROOT
  ? path.resolve(process.env.LIMCODE_TEST_EXTENSION_ROOT)
  : path.resolve('dist/extension');
const {
  approvedSubmitPlanTaskOperation,
  buildCurrentTurnTaskProjection,
  estimateTurnTaskCardTokens,
  freezeCurrentTurnTaskCard,
  readCurrentTurnTaskCard,
  shouldInjectTurnTaskCard,
  taskListOperationFromSettledArtifact
} = require(path.join(compiledRoot, 'backend/reliableKernel/currentTurnTaskProjection.js'));
const {
  conversationForkSnapshotCopyId
} = require(path.join(compiledRoot, 'backend/reliableKernel/conversationForkSnapshot.js'));
const {
  requireTaskListOperation,
  taskListOperationFromArgs
} = require(path.join(compiledRoot, 'shared/taskListProjection.js'));
const {
  normalizeSubmitPlanToolRequest
} = require(path.join(compiledRoot, 'shared/planReview.js'));

const rewrite = (items) => ({ kind: 'task_list.operation', mode: 'rewrite', items });
const update = (items) => ({ kind: 'task_list.operation', mode: 'update', items });
const fact = (callSeq, operation, options = {}) => ({
  toolCallId: options.toolCallId ?? `task-call-${callSeq}`,
  callSeq: String(callSeq),
  toolName: options.toolName ?? 'update_task_list',
  operation,
  ...(options.planApproved === true ? { planApproved: true } : {}),
  ...(options.sourceTurnId ? { sourceTurnId: options.sourceTurnId } : {}),
  sourceMessageId: options.sourceMessageId ?? `message-${callSeq}`,
  ...(options.sourceMessageSeq !== undefined ? { sourceMessageSeq: String(options.sourceMessageSeq) } : {}),
  ...(options.providerOrdinal !== undefined ? { providerOrdinal: String(options.providerOrdinal) } : {})
});

test('task card reminder 只在任务快照或压缩边界变化时注入', () => {
  const unchanged = {
    revision: '2:task-call-2',
    cardSha256: 'same-card',
    boundaryKey: 'compression-segment-1'
  };
  assert.equal(shouldInjectTurnTaskCard(unchanged, undefined), true);
  assert.equal(shouldInjectTurnTaskCard(unchanged, { ...unchanged }), false);
  assert.equal(shouldInjectTurnTaskCard({ ...unchanged, revision: '3:task-call-3' }, unchanged), true);
  assert.equal(shouldInjectTurnTaskCard({ ...unchanged, cardSha256: 'changed-card' }, unchanged), true);
  assert.equal(shouldInjectTurnTaskCard({ ...unchanged, boundaryKey: 'compression-segment-2' }, unchanged), true);
});

test('task operation 只在一个严格边界规范化完整 mode/items', () => {
  assert.deepEqual(requireTaskListOperation({
    mode: 'rewrite',
    items: [{ title: '  First   task ', description: ' two   words ', status: 'in_progress', delete: false }]
  }), {
    kind: 'task_list.operation',
    mode: 'rewrite',
    items: [{ title: 'First task', description: 'two words', status: 'in_progress' }]
  });
  assert.throws(() => requireTaskListOperation({ mode: 'rewrite', items: [{ title: 'x', status: 'done' }] }), /status is invalid/);
  assert.throws(() => requireTaskListOperation({ mode: 'rewrite', items: [{ title: 'x', delete: true }] }), /only be used in update mode/);
  assert.deepEqual(requireTaskListOperation({ mode: 'update', items: [{ title: 'x', delete: true, status: 'completed' }] }), {
    kind: 'task_list.operation', mode: 'update', items: [{ title: 'x', delete: true }]
  });
  assert.throws(() => requireTaskListOperation({ mode: 'rewrite', items: [], extra: true }), /unsupported fields/);
  assert.throws(() => requireTaskListOperation({
    mode: 'rewrite',
    items: [{ title: 'Same task' }, { title: '  same   TASK ' }]
  }), /duplicate title/);
  assert.equal(taskListOperationFromArgs({ mode: 'rewrite', items: [{ title: 'x', unknown: true }] }), undefined);
});

test('submit_plan 必须携带完整结构化 taskList 合同', () => {
  assert.throws(
    () => normalizeSubmitPlanToolRequest({ plan: 'inspect then fix' }),
    /taskList is required/
  );
  assert.throws(
    () => normalizeSubmitPlanToolRequest({
      plan: 'inspect then fix',
      taskList: { mode: 'update', items: [{ title: 'inspect' }] }
    }),
    /must use mode="rewrite"/
  );
  assert.throws(
    () => normalizeSubmitPlanToolRequest({
      plan: 'inspect then fix',
      taskList: { mode: 'rewrite', items: [] }
    }),
    /at least one task/
  );
  assert.throws(
    () => normalizeSubmitPlanToolRequest({
      plan: 'inspect then fix',
      taskList: { mode: 'rewrite', items: [{ title: 'inspect' }, { title: ' Inspect ' }] }
    }),
    /taskList must use the same shape/
  );
  assert.deepEqual(normalizeSubmitPlanToolRequest({
    plan: 'inspect then fix',
    taskList: { mode: 'rewrite', items: [
      { title: ' inspect ', description: ' full description ', status: 'in_progress' },
      { title: 'fix', status: 'pending' }
    ] }
  }), {
    plan: 'inspect then fix',
    taskList: { kind: 'task_list.operation', mode: 'rewrite', items: [
      { title: 'inspect', description: 'full description', status: 'in_progress' },
      { title: 'fix', status: 'pending' }
    ] }
  });
});

test('没有 rewrite 基线时不从 update 或未批准 Plan 伪造任务卡', () => {
  const projection = buildCurrentTurnTaskProjection({
    turnId: 'turn-update-only',
    operations: [
      fact(1, update([{ title: 'increment only', status: 'in_progress' }])),
      fact(2, rewrite([{ title: 'rejected plan' }]), { toolName: 'submit_plan' })
    ]
  });
  assert.equal(projection, undefined);
});

test('approved Plan rewrite 可建基线，只应用同 Turn 中其后的有效 update', () => {
  const projection = buildCurrentTurnTaskProjection({
    turnId: 'turn-approved-plan',
    operations: [
      fact(1, update([{ title: 'ignored early update', status: 'completed' }])),
      fact(2, rewrite([{ title: 'rejected rewrite' }]), { toolName: 'submit_plan' }),
      fact(3, rewrite([
        { title: 'Implement', status: 'pending' },
        { title: 'Already done', status: 'completed' }
      ]), { toolName: 'submit_plan', planApproved: true }),
      fact(4, update([
        { title: 'Implement', status: 'in_progress' },
        { title: 'Verify', status: 'blocked' }
      ])),
      fact(5, rewrite([{ title: 'change requested must not replace' }]), { toolName: 'submit_plan' }),
      fact(6, update([{ title: 'Verify', status: 'pending' }]))
    ]
  });
  assert.ok(projection);
  assert.equal(projection.baselineToolCallId, 'task-call-3');
  assert.equal(projection.sourceToolCallId, 'task-call-6');
  assert.equal(projection.operationCount, 3);
  assert.deepEqual(projection.snapshot.items.map((item) => [item.title, item.status]), [
    ['Implement', 'in_progress'],
    ['Already done', 'completed'],
    ['Verify', 'pending']
  ]);
  assert.deepEqual(projection.counts, {
    total: 3,
    unfinished: 2,
    pending: 1,
    inProgress: 1,
    blocked: 0,
    completed: 1,
    cancelled: 0
  });
});

test('Conversation 任务基线允许后续 Turn 使用 update-only 继续', () => {
  const projection = buildCurrentTurnTaskProjection({
    turnId: 'turn-b',
    operations: [
      fact(1, rewrite([
        { title: 'Implement', status: 'in_progress' },
        { title: 'Verify', status: 'pending' }
      ]), {
        toolCallId: 'turn-a-rewrite',
        sourceTurnId: 'turn-a',
        sourceMessageId: 'message-10',
        sourceMessageSeq: 10,
        providerOrdinal: 0
      }),
      fact(1, update([
        { title: 'Implement', status: 'completed' },
        { title: 'Verify', status: 'in_progress' }
      ]), {
        toolCallId: 'turn-b-update',
        sourceTurnId: 'turn-b',
        sourceMessageId: 'message-20',
        sourceMessageSeq: 20,
        providerOrdinal: 0
      })
    ]
  });
  assert.ok(projection);
  assert.equal(projection.baselineToolCallId, 'turn-a-rewrite');
  assert.equal(projection.sourceToolCallId, 'turn-b-update');
  assert.equal(projection.sourceTurnId, 'turn-b');
  assert.equal(projection.revision, '20:0:1:turn-b-update');
  assert.deepEqual(projection.snapshot.items.map((item) => [item.title, item.status]), [
    ['Implement', 'completed'],
    ['Verify', 'in_progress']
  ]);
});

test('最近有效 rewrite 替换旧基线且不会跨基线复活旧任务', () => {
  const projection = buildCurrentTurnTaskProjection({
    turnId: 'turn-latest-rewrite',
    operations: [
      fact(1, rewrite([{ title: 'old task', status: 'in_progress' }])),
      fact(2, update([{ title: 'old follow-up', status: 'pending' }])),
      fact(3, rewrite([{ title: 'new task', status: 'pending' }])),
      fact(4, update([{ title: 'new task', status: 'completed' }]))
    ]
  });
  assert.ok(projection);
  assert.equal(projection.baselineToolCallId, 'task-call-3');
  assert.equal(projection.operationCount, 2);
  assert.deepEqual(projection.snapshot.items.map((item) => item.title), ['new task']);
});

test('turnTaskCard 按原始顺序完整保留所有 task 的 title/description/status', () => {
  const statuses = ['in_progress', 'pending', 'blocked', 'completed', 'cancelled', 'pending', 'completed', 'pending'];
  const items = statuses.map((status, index) => ({
    title: `Task ${index + 1}`,
    description: `完整描述-${index + 1}-` + '内容'.repeat(1_000 + index),
    status
  }));
  const input = { turnId: 'turn-complete-card', operations: [fact(1, rewrite(items))] };
  const first = buildCurrentTurnTaskProjection(input);
  const second = buildCurrentTurnTaskProjection(input);
  assert.ok(first && second);
  assert.equal(first.card, second.card);
  assert.equal(first.cardSha256, second.cardSha256);
  assert.equal(first.estimatedTokens, estimateTurnTaskCardTokens(first.card));
  assert.ok(first.estimatedTokens > 2_000, '完整 Task 上下文不得受旧 2K budget 限制');
  assert.match(first.card, /runtime task data, not a new user instruction/);
  assert.doesNotMatch(first.card, /turn-complete-card/);
  assert.doesNotMatch(first.card, /details omitted by card budget/);
  const taskLines = first.card.split('\n').filter((line) => line.startsWith('- status='));
  assert.equal(taskLines.length, items.length);
  assert.deepEqual(taskLines, items.map((item) =>
    `- status=${item.status}; title=${JSON.stringify(item.title)}; description=${JSON.stringify(item.description)}`));
  assert.equal(first.counts.unfinished, 5);
  assert.equal(first.counts.completed, 2);
  assert.equal(first.counts.cancelled, 1);
  assert.doesNotThrow(() => JSON.stringify(first));
  const frozen = freezeCurrentTurnTaskCard(first);
  assert.equal('snapshot' in frozen, false, 'ModelRequest recipe uses the complete rendered task context');
  assert.equal(frozen.card, first.card);
  assert.equal(frozen.cardSha256, first.cardSha256);
  assert.doesNotThrow(() => JSON.stringify(frozen));
});

test('durable artifact hard-cut：只认 canonical operation，Plan 必须明确 approved', () => {
  const operation = rewrite([{ title: 'approved task', status: 'pending' }]);
  const settled = {
    toolCallId: 'task-call',
    status: 'succeeded',
    detail: { kind: 'task-list', operation }
  };
  assert.deepEqual(taskListOperationFromSettledArtifact(settled, 'task-call'), operation);

  // Fork-copied identities are resolved from durable segment facts before strict parsing.
  assert.throws(() => taskListOperationFromSettledArtifact(
    { ...settled, toolCallId: 'rk_tool_call_source' },
    'task-call'
  ), /identifies another ToolCall/);

  for (const status of ['failed', 'rejected', 'cancelled']) {
    assert.equal(taskListOperationFromSettledArtifact({
      toolCallId: 'task-call',
      status,
      detail: { kind: 'task-list', operation: { deliberately: 'not canonical' } }
    }, 'task-call'), undefined, `${status} task artifact must be ignored before canonical validation`);
  }
  assert.throws(() => taskListOperationFromSettledArtifact({
    toolCallId: 'task-call',
    status: 'succeeded',
    detail: { kind: 'task-list', items: operation.items }
  }, 'task-call'), /Task list operation must be a plain object/);

  const planArgs = { plan: 'do it', taskList: operation };
  const result = (status, executionTarget = 'current_conversation') => ({
    toolCallId: 'plan-call',
    status: status === 'approved'
      ? 'succeeded'
      : status === 'cancelled'
        ? 'cancelled'
        : 'rejected',
    detail: {
      kind: 'submit_plan.result',
      proposalId: 'proposal',
      status,
      ...(status === 'approved' ? { executionTarget } : {})
    }
  });
  assert.deepEqual(approvedSubmitPlanTaskOperation({
    argumentsValue: planArgs,
    resultArtifactValue: result('approved'),
    toolCallId: 'plan-call'
  }), operation);
  assert.equal(approvedSubmitPlanTaskOperation({
    argumentsValue: planArgs,
    resultArtifactValue: result('approved', 'new_conversation'),
    toolCallId: 'plan-call'
  }), undefined);
  assert.equal(approvedSubmitPlanTaskOperation({
    argumentsValue: planArgs,
    resultArtifactValue: result('change_requested'),
    toolCallId: 'plan-call'
  }), undefined);
  assert.equal(approvedSubmitPlanTaskOperation({
    argumentsValue: planArgs,
    resultArtifactValue: result('rejected'),
    toolCallId: 'plan-call'
  }), undefined);
  assert.equal(approvedSubmitPlanTaskOperation({
    argumentsValue: planArgs,
    resultArtifactValue: result('cancelled'),
    toolCallId: 'plan-call'
  }), undefined);
});

test('任务卡按不可变 ToolCall 前缀读取，无关 commitSeq 连续变化不会失败主 Turn', async () => {
  const toolCallId = 'task-prefix-race-call';
  const artifact = {
    id: 'task-prefix-race-artifact',
    tool_call_id: toolCallId,
    role: 'no_effect_result',
    content_object_id: 'task-prefix-race-result'
  };
  let snapshotCount = 0;
  const database = {
    async snapshotAll() {
      return {
        snapshotCommitSeq: '11',
        snapshot: [{
          id: 'task-prefix-race-turn',
          conversation_id: 'task-prefix-race-conversation'
        }]
      };
    },
    async snapshot() {
      snapshotCount += 1;
      if (snapshotCount === 1) {
        return {
          snapshotCommitSeq: '10',
          snapshot: [{
            id: 'task-prefix-race-turn',
            conversation_id: 'task-prefix-race-conversation'
          }]
        };
      }
      if (snapshotCount === 2) {
        return {
          snapshotCommitSeq: '12',
          snapshot: [[{
            id: toolCallId,
            turn_id: 'task-prefix-race-turn',
            call_seq: 1n,
            tool_name: 'update_task_list',
            arguments_object_id: 'task-prefix-race-arguments'
          }]]
        };
      }
      if (snapshotCount === 3) {
        return {
          snapshotCommitSeq: '13',
          snapshot: [
            [artifact],
            { id: 'task-prefix-race-arguments' },
            [{
              message_id: 'task-prefix-race-message',
              provider_ordinal: 0n
            }]
          ]
        };
      }
      if (snapshotCount === 4) {
        return {
          snapshotCommitSeq: '14',
          snapshot: [{ id: 'task-prefix-race-result' }]
        };
      }
      return {
        snapshotCommitSeq: '15',
        snapshot: [
          [{
            conversation_id: 'task-prefix-race-conversation',
            message_id: 'task-prefix-race-message',
            message_seq: 1n
          }],
          { id: 'task-prefix-race-message', deleted_at: null }
        ]
      };
    }
  };
  const contentStore = {
    async read(metadata) {
      assert.equal(metadata.id, 'task-prefix-race-result');
      return Buffer.from(JSON.stringify({
        toolCallId,
        status: 'succeeded',
        detail: {
          kind: 'task-list',
          operation: rewrite([{ title: 'survives unrelated commits', status: 'in_progress' }])
        }
      }), 'utf8');
    }
  };
  const frozen = await readCurrentTurnTaskCard(
    database,
    contentStore,
    'task-prefix-race-turn'
  );
  assert.ok(frozen);
  assert.equal(frozen.frozenAtCommitSeq, '15');
  assert.equal(frozen.counts.unfinished, 1);
  assert.match(frozen.card, /survives unrelated commits/);
  assert.equal('snapshot' in frozen, false);
  assert.equal(snapshotCount, 5);
});

function forkTaskFixture(depth, options = {}) {
  const conversations = Array.from({ length: depth + 1 }, (unused, index) => 'conversation-fork-' + index);
  const conversationId = conversations.at(-1);
  const sourceToolCallId = 'original-task-call';
  const copiedToolIds = [sourceToolCallId];
  for (const targetId of conversations.slice((options.originDepth ?? 0) + 1)) {
    copiedToolIds.push(conversationForkSnapshotCopyId(targetId, 'tool_call', copiedToolIds.at(-1)));
  }
  const toolCallId = copiedToolIds.at(-1);
  const operation = rewrite([{ title: 'inherited task', status: 'in_progress' }]);
  const artifact = {
    toolCallId: options.unrelated ? 'unrelated-task-call' : sourceToolCallId,
    status: 'succeeded',
    detail: options.plan
      ? { kind: 'submit_plan.result', proposalId: 'proposal', status: 'approved', executionTarget: 'current_conversation' }
      : { kind: 'task-list', operation }
  };
  const tables = {
    Turn: [{ id: 'new-turn', conversation_id: conversationId }],
    ToolCall: [{ id: toolCallId, turn_id: 'new-turn', call_seq: 1n, tool_name: options.plan ? 'submit_plan' : 'update_task_list', arguments_object_id: 'arguments' }],
    ToolResultArtifact: [{ id: 'artifact', tool_call_id: toolCallId, role: 'no_effect_result', content_object_id: 'result' }],
    ContentObject: [{ id: 'arguments' }, { id: 'result' }],
    ToolCallSourceLink: [{ tool_call_id: toolCallId, message_id: 'message', provider_ordinal: 0n }],
    MessagePartOfConversation: [{ message_id: 'message', conversation_id: conversationId, message_seq: 1n }],
    Message: [{ id: 'message', deleted_at: null }],
    ContextSegmentSource: copiedToolIds.map((sourceId, index) => ({
      id: 'segment-source-' + index, segment_id: 'shared-tool-segment', source_kind: 'tool_call',
      source_id: sourceId, source_revision: 1n
    })),
    ConversationBranchLink: options.deletedParents ? [] : conversations.slice(1).map((target, index) => ({
      id: 'branch-' + index, target_conversation_id: target, source_conversation_id: conversations[index]
    }))
  };
  if (options.wrongSegment) tables.ContextSegmentSource.at(-1).segment_id = 'unrelated-segment';
  if (options.wrongRevision) tables.ContextSegmentSource.at(-1).source_revision = 2n;
  if (options.missingSource) tables.ContextSegmentSource.shift();
  if (options.ambiguousSource) tables.ContextSegmentSource.push({ ...tables.ContextSegmentSource[0], id: 'duplicate-source' });
  let sourceReads = 0;
  let branchReads = 0;
  const read = (query) => {
    if (query.domain === 'ContextSegmentSource') sourceReads += 1;
    if (query.domain === 'ConversationBranchLink') branchReads += 1;
    const values = tables[query.domain] ?? [];
    if (query.kind === 'get') return values.find((value) => value.id === query.id) ?? null;
    return values.filter((value) => Object.entries(query.where ?? {}).every(([key, expected]) => value[key] === expected));
  };
  const database = {
    async snapshot(queries) { return { snapshotCommitSeq: '20', snapshot: queries.map(read) }; },
    async snapshotAll(query) { return { snapshotCommitSeq: '20', snapshot: read(query) }; }
  };
  const contentStore = {
    async read(metadata) {
      return Buffer.from(JSON.stringify(metadata.id === 'result' ? artifact : { plan: 'approved plan', taskList: operation }));
    }
  };
  return { database, contentStore, artifact, toolCallId, sourceReads: () => sourceReads, branchReads: () => branchReads };
}

for (const depth of [0, 1, 2, 3]) {
  test('任务卡读取第 ' + depth + ' 层手动分支时保留合法的历史工具结果', async () => {
    const fixture = forkTaskFixture(depth);
    const before = structuredClone(fixture.artifact);
    const card = await readCurrentTurnTaskCard(fixture.database, fixture.contentStore, 'new-turn');
    assert.equal(card.sourceToolCallId, fixture.toolCallId);
    assert.equal(card.counts.inProgress, 1);
    assert.match(card.card, /inherited task/);
    assert.deepEqual(fixture.artifact, before, '读取投影不能改写持久化结果');
    if (depth === 0) assert.equal(fixture.sourceReads(), 0, '原生调用不增加来源查询');
    else assert.equal(fixture.sourceReads(), 2, '任意层分支都只用一次批量来源查询');
  });
}

test('多级分支支持中途创建的任务和已审批计划', async () => {
  for (const options of [{ originDepth: 1 }, { plan: true }, { plan: true, originDepth: 1 }]) {
    const fixture = forkTaskFixture(3, options);
    const card = await readCurrentTurnTaskCard(fixture.database, fixture.contentStore, 'new-turn');
    assert.equal(card.counts.inProgress, 1);
    assert.equal(card.sourceToolCallId, fixture.toolCallId);
  }
});

test('多级分支仍拒绝无关工具结果、缺失来源和不同工具段', async () => {
  for (const options of [
    { unrelated: true }, { wrongSegment: true }, { wrongRevision: true },
    { missingSource: true }, { ambiguousSource: true }, { unrelated: true, plan: true }
  ]) {
    const fixture = forkTaskFixture(2, options);
    await assert.rejects(readCurrentTurnTaskCard(fixture.database, fixture.contentStore, 'new-turn'), /identifies another ToolCall/);
  }
});

test('多级分支在父会话已删除时仍用不可变工具段验证归属', async () => {
  const fixture = forkTaskFixture(5, { deletedParents: true });
  const card = await readCurrentTurnTaskCard(fixture.database, fixture.contentStore, 'new-turn');
  assert.equal(card.sourceToolCallId, fixture.toolCallId);
  assert.equal(card.counts.inProgress, 1);
  assert.equal(fixture.branchReads(), 0);
});
