import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
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

const Database = require('better-sqlite3');
const { readCurrentTurnTaskSnapshot } = require(path.join(compiledRoot, 'backend/reliableKernel/currentTurnTaskSnapshot.js'));
const { DOMAIN_REPOSITORIES } = require(path.join(compiledRoot, 'backend/reliableKernel/repositories.js'));
const { RUNTIME_DOMAIN_SCHEMAS } = require(path.join(compiledRoot, 'backend/reliableKernel/schema/domainManifest.js'));

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
    card: 'same-card',
    boundaryKey: 'compression-segment-1'
  };
  assert.equal(shouldInjectTurnTaskCard(unchanged, undefined), true);
  assert.equal(shouldInjectTurnTaskCard(unchanged, { ...unchanged }), false);
  assert.equal(shouldInjectTurnTaskCard({ ...unchanged, revision: '3:task-call-3' }, unchanged), true);
  assert.equal(shouldInjectTurnTaskCard({ ...unchanged, card: 'changed-card' }, unchanged), true);
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
  assert.equal('cardSha256' in first, false, 'card equality must not hash its already-frozen bytes');
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
  assert.equal('cardSha256' in frozen, false);
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

test('任务卡只用一次 worker snapshot，不以全局 commitSeq 作为变化判断', async () => {
  let reads = 0;
  const database = {
    async currentTurnTaskSnapshot(turnId) {
      reads++;
      assert.equal(turnId, 'current-turn');
      return { snapshotCommitSeq: String(10 + reads), snapshot: { turnId, operations: [
        fact(1, rewrite([{ title: 'survives unrelated commits', status: 'in_progress' }]))
      ] } };
    },
    snapshot() { assert.fail('Host must not issue per-call or per-Turn reads'); },
    snapshotAll() { assert.fail('Host must not inventory all Turns'); }
  };
  const first = await readCurrentTurnTaskCard(database, 'current-turn');
  const second = await readCurrentTurnTaskCard(database, 'current-turn');
  assert.equal(reads, 2);
  assert.equal(first.card, second.card);
  assert.notEqual(first.frozenAtCommitSeq, second.frozenAtCommitSeq);
  assert.equal(shouldInjectTurnTaskCard({ ...second, boundaryKey: 'same' }, { ...first, boundaryKey: 'same' }), false);
  assert.equal('snapshot' in first, false);
});

function taskSnapshotFixture(options = {}) {
  const directory = options.shared ? fs.mkdtempSync(path.join(os.tmpdir(), 'limcode-task-snapshot-')) : undefined;
  const file = directory ? path.join(directory, 'runtime.sqlite3') : ':memory:';
  const statements = [];
  const writer = new Database(file, { verbose: (sql) => statements.push(sql) });
  writer.defaultSafeIntegers(true);
  if (directory) writer.pragma('journal_mode = WAL');
  // Real domain columns/codecs; no production schema changes. Omit FK parents so corruption
  // fixtures can prove the current authority boundary without constructing an entire Runtime.
  for (const schema of RUNTIME_DOMAIN_SCHEMAS) {
    writer.exec(`CREATE TABLE "${schema.table}" (${schema.columns.map((column) =>
      `"${column.name}" ${column.type}${column.name === 'id' ? ' PRIMARY KEY' : ''}`
    ).join(',')})`);
  }
  writer.exec(`
    CREATE UNIQUE INDEX membership_sequence ON message_part_of_conversation(conversation_id,message_seq);
    CREATE UNIQUE INDEX membership_message ON message_part_of_conversation(message_id);
    CREATE UNIQUE INDEX source_call ON tool_call_source_link(tool_call_id);
    CREATE INDEX source_message ON tool_call_source_link(message_id);
    CREATE UNIQUE INDEX call_sequence ON tool_call(turn_id,call_seq);
    CREATE UNIQUE INDEX artifact_role ON tool_result_artifact(tool_call_id,role);
    CREATE UNIQUE INDEX context_source ON context_segment_source(source_kind,source_id,source_revision);
  `);
  const reader = directory ? new Database(file, { readonly: true, verbose: (sql) => statements.push(sql) }) : writer;
  reader.defaultSafeIntegers(true);
  const contents = new Map();
  const bodyReads = [];
  const facts = [];
  let beforeRead;
  function insert(domain, input) {
    const repository = DOMAIN_REPOSITORIES.domain(domain);
    const defaults = Object.fromEntries(repository.schema.columns.map((column) => [column.name,
      column.nullable ? null : column.type === 'INTEGER' ? 1n : column.json ? {} :
        column.name.endsWith('_at') ? '2026-10-04T00:00:00.000Z' : `${domain}-${column.name}`
    ]));
    const row = repository.codec.encodeInsert({ ...defaults, ...input });
    const columns = Object.keys(row);
    writer.prepare(`INSERT INTO "${repository.schema.table}" (${columns.map((key) => `"${key}"`).join(',')}) VALUES (${columns.map((key) => `@${key}`).join(',')})`).run(row);
  }
  function content(id, value) {
    const bytes = Buffer.from(typeof value === 'string' ? value : JSON.stringify(value));
    const sha256 = createHash('sha256').update(bytes).digest('hex');
    contents.set(id, bytes);
    insert('ContentObject', { id, content_type: 'application/json', sha256, byte_length: BigInt(bytes.length), storage_key: `sha256/${sha256.slice(0, 2)}/${sha256}` });
    return id;
  }
  function task(id, operation, input = {}) {
    const toolName = input.plan ? 'submit_plan' : 'update_task_list';
    const turnId = input.turnId ?? 'new-turn';
    const conversationId = input.conversationId ?? 'conversation';
    const messageId = input.messageId ?? `${id}-message`;
    const messageSeq = BigInt(input.messageSeq ?? facts.length + 1);
    const ordinal = BigInt(input.ordinal ?? 0);
    const callSeq = BigInt(input.callSeq ?? facts.length + 1);
    if (!input.existingMessage) {
      insert('Message', { id: messageId, deleted_at: input.deleted ? '2026-10-04T00:00:00.000Z' : null });
      insert('MessagePartOfConversation', { id: `${id}-membership`, message_id: messageId, conversation_id: conversationId, message_seq: messageSeq });
    }
    insert('ToolCall', { id, turn_id: turnId, call_seq: callSeq, tool_name: input.toolName ?? toolName,
      status: 'succeeded', arguments_object_id: content(`${id}-arguments`, input.arguments ?? { taskList: operation }) });
    insert('ToolCallSourceLink', { id: `${id}-source`, tool_call_id: id, message_id: messageId,
      model_request_id: `${id}-request`, provider_ordinal: ordinal });
    const artifact = input.artifact ?? { toolCallId: input.claimedId ?? id, status: input.status ?? 'succeeded', detail: input.plan
      ? { kind: 'submit_plan.result', proposalId: 'proposal', status: input.planStatus ?? 'approved', executionTarget: input.executionTarget ?? 'current_conversation' }
      : { kind: 'task-list', operation } };
    insert('ToolResultArtifact', { id: `${id}-artifact`, tool_call_id: id, role: 'no_effect_result', content_object_id: content(`${id}-result`, artifact) });
    facts.push(fact(callSeq, operation, { toolCallId: id, toolName, sourceTurnId: turnId,
      sourceMessageId: messageId, sourceMessageSeq: messageSeq, providerOrdinal: ordinal, planApproved: input.plan === true }));
    return id;
  }
  const database = { async currentTurnTaskSnapshot(turnId) {
    const snapshot = reader.transaction(() => readCurrentTurnTaskSnapshot(reader, turnId, (metadata) => {
      bodyReads.push(metadata.id);
      beforeRead?.(metadata);
      const bytes = contents.get(metadata.id);
      assert.ok(bytes, `Missing fixture CAS ${metadata.id}`);
      assert.equal(createHash('sha256').update(bytes).digest('hex'), metadata.sha256);
      return bytes;
    }))();
    return { snapshotCommitSeq: '0', snapshot };
  } };
  insert('Turn', { id: 'new-turn', conversation_id: 'conversation' });
  return { writer, reader, insert, content, task, contents, bodyReads, statements, facts, database,
    beforeRead(callback) { beforeRead = callback; },
    async card() { return readCurrentTurnTaskCard(database, 'new-turn'); },
    resetCounts() { statements.length = 0; bodyReads.length = 0; },
    close() { if (reader !== writer) reader.close(); writer.close(); if (directory) fs.rmSync(directory, { recursive: true, force: true }); }
  };
}

function forkTaskFixture(depth, options = {}) {
  const f = taskSnapshotFixture();
  const conversations = Array.from({ length: depth + 1 }, (_, index) => 'conversation-fork-' + index);
  const sourceToolCallId = 'original-task-call';
  const copiedToolIds = [sourceToolCallId];
  for (const targetId of conversations.slice((options.originDepth ?? 0) + 1)) {
    copiedToolIds.push(conversationForkSnapshotCopyId(targetId, 'tool_call', copiedToolIds.at(-1)));
  }
  const toolCallId = copiedToolIds.at(-1);
  f.task(toolCallId, rewrite([{ title: 'inherited task', status: 'in_progress' }]), {
    plan: options.plan, claimedId: options.unrelated ? 'unrelated-task-call' : sourceToolCallId
  });
  const sources = copiedToolIds.map((sourceId, index) => ({
    id: 'segment-source-' + index, segment_id: 'shared-tool-segment', source_kind: 'tool_call', source_id: sourceId, source_revision: 1n
  }));
  if (options.wrongSegment) sources.at(-1).segment_id = 'unrelated-segment';
  if (options.wrongRevision) sources.at(-1).source_revision = 2n;
  if (options.missingSource) sources.shift();
  // Same kind/id at another revision is legal SQLite structure but ambiguous identity evidence.
  if (options.ambiguousSource) sources.push({ ...sources[0], id: 'duplicate-source', source_revision: 2n });
  for (const source of sources) f.insert('ContextSegmentSource', source);
  f.resetCounts();
  return { ...f, toolCallId };
}

for (const depth of [0, 1, 2, 3]) {
  test('任务卡读取第 ' + depth + ' 层手动分支时保留合法的历史工具结果', async () => {
    const f = forkTaskFixture(depth);
    try {
      const before = Buffer.from(f.contents.get(`${f.toolCallId}-result`));
      const card = await f.card();
      assert.equal(card.sourceToolCallId, f.toolCallId);
      assert.equal(card.counts.inProgress, 1);
      assert.match(card.card, /inherited task/);
      assert.deepEqual(f.contents.get(`${f.toolCallId}-result`), before, '读取投影不能改写持久化结果');
      const identityReads = f.statements.filter(sql => /FROM context_segment_source/.test(sql));
      assert.equal(identityReads.length, depth === 0 ? 0 : 2, '只验证实际使用的复制身份');
    } finally { f.close(); }
  });
}

test('多级分支支持中途创建的任务和已审批计划', async () => {
  for (const options of [{ originDepth: 1 }, { plan: true }, { plan: true, originDepth: 1 }]) {
    const f = forkTaskFixture(3, options);
    try {
      const card = await f.card();
      assert.equal(card.counts.inProgress, 1);
      assert.equal(card.sourceToolCallId, f.toolCallId);
    } finally { f.close(); }
  }
});

test('多级分支仍拒绝无关工具结果、缺失来源和不同工具段', async () => {
  for (const options of [
    { unrelated: true }, { wrongSegment: true }, { wrongRevision: true },
    { missingSource: true }, { ambiguousSource: true }, { unrelated: true, plan: true }
  ]) {
    const f = forkTaskFixture(2, options);
    try { await assert.rejects(f.card(), /identifies another ToolCall/); }
    finally { f.close(); }
  }
});

test('多级分支在父会话已删除时仍用不可变工具段验证归属', async () => {
  const f = forkTaskFixture(5);
  try {
    const card = await f.card();
    assert.equal(card.sourceToolCallId, f.toolCallId);
    assert.equal(card.counts.inProgress, 1);
    assert.equal(f.statements.some(sql => /conversation_branch_link/i.test(sql)), false);
  } finally { f.close(); }
});

test('任务卡空历史不逐 Turn 探测，正文读取只随最新 rewrite 后缀增长', async () => {
  const f = taskSnapshotFixture();
  try {
    for (let index = 0; index < 1200; index++) {
      f.insert('Turn', { id: `empty-${index}`, conversation_id: 'conversation' });
    }
    f.resetCounts();
    assert.equal(await f.card(), undefined);
    assert.equal(f.statements.filter(sql => /^\s*SELECT/.test(sql)).length, 2);
    assert.deepEqual(f.bodyReads, []);
    for (let index = 0; index < 500; index++) f.task(`old-${index}`, rewrite([{ title: `old ${index}` }]));
    f.task('baseline', rewrite([{ title: 'work', status: 'pending' }]));
    f.task('update', update([{ title: 'work', status: 'completed' }]));
    f.resetCounts();
    const card = await f.card();
    const expected = freezeCurrentTurnTaskCard(buildCurrentTurnTaskProjection({ turnId: 'new-turn', operations: f.facts, frozenAtCommitSeq: '0' }));
    assert.deepEqual(card, expected);
    assert.deepEqual(f.bodyReads, ['update-result', 'baseline-result']);
    assert.equal(f.statements.filter(sql => /^\s*SELECT/.test(sql)).length, 4);
  } finally { f.close(); }
});

test('被最新 rewrite 取代的损坏正文不再参与任务卡验证，当前后缀仍严格失败', async () => {
  const f = taskSnapshotFixture();
  try {
    f.task('old-malformed', rewrite([]), { artifact: '{broken' });
    f.task('old-missing', rewrite([]));
    f.contents.delete('old-missing-result');
    f.task('baseline', rewrite([{ title: 'current', status: 'pending' }]));
    f.resetCounts();
    assert.equal((await f.card()).baselineToolCallId, 'baseline');
    assert.deepEqual(f.bodyReads, ['baseline-result']);
    f.task('current-malformed', update([]), { artifact: '{broken' });
    await assert.rejects(f.card(), /not valid JSON/);
  } finally { f.close(); }
});

test('任务顺序使用 Message/provider ordinal，隐藏或其他会话的 rewrite 不取得权威', async () => {
  const f = taskSnapshotFixture();
  try {
    f.insert('Turn', { id: 'older-turn', conversation_id: 'conversation' });
    f.insert('Turn', { id: 'foreign-turn', conversation_id: 'foreign' });
    f.task('baseline', rewrite([{ title: 'ordered', status: 'pending' }]), { turnId: 'older-turn', callSeq: 40, messageSeq: 10 });
    f.task('update-last', update([{ title: 'ordered', status: 'completed' }]), { callSeq: 1, messageSeq: 20, ordinal: 8, messageId: 'shared' });
    f.task('update-first', update([{ title: 'ordered', status: 'in_progress' }]), { callSeq: 2, messageSeq: 20, ordinal: 2, messageId: 'shared', existingMessage: true });
    f.task('deleted', rewrite([{ title: 'hidden' }]), { callSeq: 3, messageSeq: 30, deleted: true, artifact: '{broken' });
    f.task('foreign-member', rewrite([{ title: 'foreign' }]), { callSeq: 4, messageSeq: 40, conversationId: 'foreign', artifact: '{broken' });
    f.task('foreign-owner', rewrite([{ title: 'foreign owner' }]), { turnId: 'foreign-turn', callSeq: 1, messageSeq: 50, artifact: '{broken' });
    f.resetCounts();
    const card = await f.card();
    assert.equal(card.baselineToolCallId, 'baseline');
    assert.equal(card.sourceToolCallId, 'update-last');
    assert.equal(card.counts.completed, 1);
    assert.equal(card.operationCount, 3);
    assert.deepEqual(f.bodyReads, ['update-last-result', 'update-first-result', 'baseline-result']);
  } finally { f.close(); }
});

test('Plan 必须成功且批准在当前 Conversation 执行，才读取参数并成为基线', async () => {
  const f = taskSnapshotFixture();
  try {
    f.task('baseline', rewrite([{ title: 'approved', status: 'pending' }]), { plan: true });
    for (const [id, input] of [
      ['rejected', { status: 'rejected', planStatus: 'rejected' }],
      ['cancelled', { status: 'cancelled', planStatus: 'cancelled' }],
      ['change-requested', { planStatus: 'change_requested' }],
      ['elsewhere', { executionTarget: 'new_conversation' }]
    ]) {
      f.task(id, rewrite([{ title: id }]), { plan: true, arguments: '{broken', ...input });
    }
    f.resetCounts();
    const card = await f.card();
    assert.equal(card.baselineToolCallId, 'baseline');
    assert.deepEqual(f.bodyReads.filter(id => id.endsWith('-arguments')), ['baseline-arguments']);
    f.task('approved-malformed', rewrite([]), { plan: true, arguments: '{broken' });
    await assert.rejects(f.card(), /not valid JSON/);
  } finally { f.close(); }
});

test('无 rewrite 的 update 后缀不制造任务卡，也不返回完整历史', async () => {
  const f = taskSnapshotFixture();
  try {
    f.task('update-only', update([{ title: 'no baseline' }]));
    assert.equal(await f.card(), undefined);
    assert.deepEqual((await f.database.currentTurnTaskSnapshot('new-turn')).snapshot.operations, []);
  } finally { f.close(); }
});

test('跨连接提交不能改变任务读取中的可见性、顺序和来源身份前沿', async () => {
  const f = taskSnapshotFixture({ shared: true });
  try {
    f.task('baseline', rewrite([{ title: 'work', status: 'pending' }]));
    f.task('update', update([{ title: 'work', status: 'completed' }]));
    let changed = false;
    f.beforeRead(() => {
      if (changed) return;
      changed = true;
      f.writer.prepare('UPDATE message SET deleted_at = ? WHERE id = ?').run('now', 'baseline-message');
      f.task('next-baseline', rewrite([{ title: 'new frontier', status: 'blocked' }]));
    });
    const during = await f.card();
    assert.equal(during.baselineToolCallId, 'baseline');
    assert.equal(during.counts.completed, 1);
    const after = await f.card();
    assert.equal(after.baselineToolCallId, 'next-baseline');
    assert.equal(after.counts.blocked, 1);
    assert.equal(during.frozenAtCommitSeq, after.frozenAtCommitSeq, 'Host-local commitSeq is not a validity fence');
  } finally { f.close(); }
});
