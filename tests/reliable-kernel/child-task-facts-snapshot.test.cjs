const assert = require('node:assert/strict');
const { createHash } = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createRequire } = require('node:module');
const test = require('node:test');
const ts = require('typescript');
const Database = require('better-sqlite3');

const root = process.cwd();
const modules = new Map();
function loadSource(relativePath) {
  const absolute = path.resolve(root, relativePath);
  if (modules.has(absolute)) return modules.get(absolute).exports;
  const loaded = { exports: {} };
  modules.set(absolute, loaded);
  const output = ts.transpileModule(fs.readFileSync(absolute, 'utf8'), {
    fileName: absolute,
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020, esModuleInterop: true }
  }).outputText;
  const fallback = createRequire(absolute);
  const localRequire = (name) => name.startsWith('.')
    ? loadSource(path.resolve(path.dirname(absolute), `${name}.ts`))
    : fallback(name);
  Function('require', 'module', 'exports', output)(localRequire, loaded, loaded.exports);
  return loaded.exports;
}
const { executeConversationChildTaskSnapshot } = loadSource('backend/reliableKernel/childTaskFactsSnapshot.ts');
const { DOMAIN_REPOSITORIES } = loadSource('backend/reliableKernel/repositories.ts');
const { RUNTIME_DOMAIN_SCHEMAS } = loadSource('backend/reliableKernel/schema/domainManifest.ts');
const { TURN_INTENT_ENVELOPE_CONTENT_TYPE } = loadSource('backend/reliableKernel/guidanceIntent.ts');
const NOW = '2026-09-22T00:00:00.000Z';

function fixture() {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'limcode-child-facts-'));
  const file = path.join(directory, 'runtime.sqlite3');
  const writer = new Database(file);
  writer.defaultSafeIntegers(true);
  writer.pragma('journal_mode = WAL');
  // These tests intentionally allow corrupt links to verify the read boundary fails closed.
  // All columns/codecs are the actual Runtime schema; no fake task aggregation tables exist.
  for (const schema of RUNTIME_DOMAIN_SCHEMAS) {
    writer.exec(`CREATE TABLE "${schema.table}" (${schema.columns.map((column) =>
      `"${column.name}" ${column.type}${column.name === 'id' ? ' PRIMARY KEY' : ''}`
    ).join(',')})`);
  }
  const reader = new Database(file, { readonly: true });
  reader.defaultSafeIntegers(true);
  const contents = new Map();
  function insert(domain, input) {
    const repository = DOMAIN_REPOSITORIES.domain(domain);
    const defaults = Object.fromEntries(repository.schema.columns.map((column) => [column.name,
      column.nullable ? null : column.type === 'INTEGER' ? 1n : column.json ? {} :
        column.name.endsWith('_at') ? NOW : `${domain}-${column.name}`
    ]));
    const row = repository.codec.encodeInsert({ ...defaults, ...input });
    const columns = Object.keys(row);
    writer.prepare(`INSERT INTO "${repository.schema.table}" (${columns.map((key) => `"${key}"`).join(',')}) VALUES (${columns.map((key) => `@${key}`).join(',')})`).run(row);
    return input.id;
  }
  function content(id, value, contentType = 'text/plain') {
    const bytes = Buffer.from(typeof value === 'string' ? value : JSON.stringify(value));
    const sha256 = createHash('sha256').update(bytes).digest('hex');
    contents.set(id, bytes);
    insert('ContentObject', { id, content_type: contentType, sha256, byte_length: BigInt(bytes.length), storage_key: `sha256/${sha256.slice(0, 2)}/${sha256}` });
    return id;
  }
  function read(database, request) {
    const repository = DOMAIN_REPOSITORIES.domain(request.domain);
    if (request.kind === 'get') {
      const row = database.prepare(`SELECT * FROM "${repository.schema.table}" WHERE id = ?`).get(request.id);
      return row ? repository.codec.decode(row) : null;
    }
    const parameters = repository.codec.encodeWhere(request.where ?? {});
    const predicates = Object.entries(parameters).map(([key, value]) => value === null ? `"${key}" IS NULL` : `"${key}" = @${key}`);
    for (const [key, value] of Object.entries(parameters)) if (value === null) delete parameters[key];
    if (request.afterId) { predicates.push('id > @after'); parameters.after = request.afterId; }
    parameters.limit = BigInt(request.limit);
    return database.prepare(`SELECT * FROM "${repository.schema.table}"${predicates.length ? ` WHERE ${predicates.join(' AND ')}` : ''} ORDER BY id ASC LIMIT @limit`)
      .all(parameters).map((row) => repository.codec.decode(row));
  }
  function snapshot(readOverride = read, envelopeRead = (metadata) => {
    const bytes = contents.get(metadata.id);
    assert.ok(bytes, `Missing fixture ContentObject ${metadata.id}`);
    assert.equal(createHash('sha256').update(bytes).digest('hex'), metadata.sha256);
    return bytes;
  }) {
    return executeConversationChildTaskSnapshot(reader, 'parent', 0n, readOverride, envelopeRead);
  }
  function child(id, parentTurn = 'parent-old-turn', parentChild = null, toolName = 'run_agent') {
    insert('Conversation', { id: `${id}-conversation`, title: id, status: 'active' });
    insert('ChildExecution', { id, child_conversation_id: `${id}-conversation`, status: 'active' });
    insert('ToolCall', { id: `${id}-source`, turn_id: parentTurn, tool_name: toolName,
      arguments_object_id: content(`${id}-args`, { action: 'spawn', task: id }, 'application/json') });
    insert('ChildExecutionParentLink', { id: `${id}-parent`, child_execution_id: id, parent_turn_id: parentTurn,
      parent_child_execution_id: parentChild, source_tool_call_id: `${id}-source` });
    insert('Turn', { id: `${id}-turn`, conversation_id: `${id}-conversation`, status: 'active' });
    insert('ChildExecutionTurnLink', { id: `${id}-turn-link`, child_execution_id: id, turn_id: `${id}-turn` });
    insert('ChildExecutionActiveTurnLink', { id: `${id}-active`, child_execution_id: id, turn_id: `${id}-turn` });
    insert('AnswerBridge', { id: `${id}-bridge`, child_execution_id: id, status: 'open' });
  }
  insert('Conversation', { id: 'parent', title: 'Main', status: 'active' });
  insert('Turn', { id: 'parent-old-turn', conversation_id: 'parent', status: 'terminated' });
  insert('Turn', { id: 'parent-current-turn', conversation_id: 'parent', status: 'active' });
  return { writer, reader, insert, content, read, snapshot, child, contents, close() {
    reader.close(); writer.close(); fs.rmSync(directory, { recursive: true, force: true });
  } };
}

test('child task facts read every parent Turn, approved Plan children and descendant lineages without active runner memory', () => {
  const f = fixture();
  try {
    f.child('earlier');
    f.child('planned', 'parent-current-turn', null, 'submit_plan');
    f.child('grandchild', 'earlier-turn', 'earlier');
    for (let i = 0; i < 1002; i++) f.insert('Turn', { id: `historic-${String(i).padStart(4, '0')}`, conversation_id: 'parent', status: 'terminated' });
    const facts = f.snapshot().snapshot;
    assert.equal(facts.parentTurns.length, 1004);
    assert.deepEqual(facts.childExecutions.map((row) => row.id), ['earlier', 'grandchild', 'planned']);
    assert.equal(facts.sourceToolCalls.find((row) => row.id === 'planned-source').tool_name, 'submit_plan');
    assert.equal(facts.parentLinks.find((row) => row.id === 'grandchild-parent').parent_child_execution_id, 'earlier');
  } finally { f.close(); }
});

test('a cross-connection commit cannot tear dependent reads and changes the content revision even when local commitSeq stays zero', () => {
  const f = fixture();
  try {
    f.child('worker');
    const before = f.snapshot();
    let changed = false;
    const during = f.snapshot((database, request) => {
      const rows = f.read(database, request);
      if (!changed && request.domain === 'Conversation') {
        changed = true;
        f.writer.prepare('UPDATE child_execution SET status = ? WHERE id = ?').run('completed', 'worker');
        f.writer.prepare('UPDATE conversation SET title = ? WHERE id = ?').run('Updated child task', 'worker-conversation');
      }
      return rows;
    });
    const after = f.snapshot();
    assert.equal(during.snapshot.childExecutions[0].status, 'active');
    assert.equal(during.snapshot.conversations[0].title, 'worker');
    assert.equal(during.snapshot.snapshotRevision, before.snapshot.snapshotRevision);
    assert.equal(after.snapshot.childExecutions[0].status, 'completed');
    assert.equal(after.snapshot.conversations[0].title, 'Updated child task');
    assert.notEqual(after.snapshot.snapshotRevision, before.snapshot.snapshotRevision);
    assert.equal(after.snapshotCommitSeq, before.snapshotCommitSeq);
  } finally { f.close(); }
});

test('queued task envelopes close immutable CAS metadata while native steer occurrence and answer handling remain separate facts', () => {
  const f = fixture();
  try {
    f.child('worker');
    const taskId = f.content('queued-task-body', 'Implement current assignment');
    const envelopeId = f.content('queued-envelope', { version: 1, kind: 'input', messageContentObjectId: taskId, guidance: { position: '1', hold: 'paused' } }, TURN_INTENT_ENVELOPE_CONTENT_TYPE);
    f.insert('TurnIntent', { id: 'queued-intent', conversation_id: 'worker-conversation', turn_id: null, state: 'queued' });
    f.insert('TurnIntentRevision', { id: 'queued-revision', intent_id: 'queued-intent', content_object_id: envelopeId });
    f.insert('ChildExecutionIntentLink', { id: 'queued-child-link', child_execution_id: 'worker', turn_intent_id: 'queued-intent', state: 'pending' });
    f.insert('Message', { id: 'steer-message' });
    f.insert('MessageRevision', { id: 'steer-revision', message_id: 'steer-message', role: 'user', content_object_id: f.content('steer-body', 'Change focus') });
    f.insert('MessageCurrentRevisionLink', { id: 'steer-current', message_id: 'steer-message', revision_id: 'steer-revision' });
    f.insert('MessagePartOfConversation', { id: 'steer-membership', message_id: 'steer-message', conversation_id: 'worker-conversation' });
    f.insert('MessageTurnLink', { id: 'steer-turn-link', message_id: 'steer-message', turn_id: 'worker-turn', role: 'native_steer' });
    f.insert('ContextSegmentSource', { id: 'steer-occurrence', segment_id: 'segment', source_kind: 'message_revision', source_id: 'steer-revision' });
    f.insert('PendingTurnInput', { id: 'steer-pending', turn_id: 'worker-turn', input_kind: 'native_steer', state: 'continuing', content_object_id: f.content('steer-envelope', { kind: 'native_steer' }, 'application/json') });
    f.insert('AnswerSubmission', { id: 'submission', answer_bridge_id: 'worker-bridge', turn_id: 'worker-turn', interrupted: 0n });
    f.insert('AnswerPayload', { id: 'answer-payload', submission_id: 'submission', content_object_id: f.content('answer-body', 'Completed task') });
    f.writer.prepare('UPDATE answer_bridge SET current_submission_id = ? WHERE id = ?').run('submission', 'worker-bridge');
    f.insert('RuntimeInboxItem', { id: 'inbox', source_kind: 'answer_submission', source_id: 'submission', state: 'available' });
    f.insert('RuntimeDelivery', { id: 'delivery', inbox_item_id: 'inbox', target_conversation_id: 'parent', target_turn_id: 'parent-current-turn', phase: 'current_turn', state: 'consumed' });
    f.insert('RuntimeDeliveryInputLink', { id: 'delivery-input', delivery_id: 'delivery', pending_turn_input_id: 'removed-parent-input', handled_at: NOW });
    const readIds = [];
    const facts = f.snapshot(f.read, (metadata) => { readIds.push(metadata.id); return f.contents.get(metadata.id); }).snapshot;
    assert.deepEqual(readIds, ['queued-envelope']);
    assert.ok(facts.contentObjects.some((row) => row.id === taskId));
    assert.equal(facts.intentLinks[0].state, 'pending');
    assert.equal(facts.contextSegmentSources[0].source_id, 'steer-revision');
    assert.equal(facts.pendingInputs[0].input_kind, 'native_steer');
    assert.equal(facts.deliveryInputLinks[0].handled_at, NOW);
    assert.equal(facts.answerSubmissions[0].id, 'submission');
  } finally { f.close(); }
});

test('foreground result closure includes a later parent wait without inventing a RuntimeDelivery', () => {
  const f = fixture();
  try {
    f.child('worker');
    f.insert('ToolCall', { id: 'later-wait', turn_id: 'parent-current-turn', tool_name: 'wait_agent', arguments_object_id: f.content('wait-args', { childRef: 'A1' }, 'application/json') });
    f.insert('Operation', { id: 'wait-operation', owner_kind: 'child_turn_answer_wait', owner_id: 'worker-turn', tool_call_id: 'later-wait', status: 'succeeded' });
    const resultId = f.content('wait-result', { status: 'completed', detail: { answerSubmissionId: 'submission', content: 'Finished' } }, 'application/json');
    f.insert('ToolOutcome', { id: 'wait-outcome', tool_call_id: 'later-wait', status: 'succeeded', content_object_id: resultId });
    f.insert('ToolResultArtifact', { id: 'wait-artifact', tool_call_id: 'later-wait', role: 'no_effect_result', content_object_id: resultId });
    f.insert('Message', { id: 'wait-message' });
    f.insert('MessageRevision', { id: 'wait-revision', message_id: 'wait-message', role: 'tool', content_object_id: resultId });
    f.insert('MessagePartOfConversation', { id: 'wait-membership', message_id: 'wait-message', conversation_id: 'parent' });
    f.insert('ToolModelResult', { id: 'wait-model-result', tool_call_id: 'later-wait', message_revision_id: 'wait-revision' });
    f.insert('ContextSegmentSource', { id: 'wait-context', segment_id: 'wait-segment', source_kind: 'tool_model_result', source_id: 'wait-model-result' });
    const facts = f.snapshot().snapshot;
    assert.ok(facts.answerToolCalls.some((row) => row.id === 'later-wait'));
    assert.equal(facts.toolOutcomes[0].content_object_id, resultId);
    assert.equal(facts.toolResultArtifacts[0].role, 'no_effect_result');
    assert.equal(facts.toolModelResults[0].id, 'wait-model-result');
    assert.equal(facts.toolResultMessageRevisions[0].id, 'wait-revision');
    assert.equal(facts.contextSegmentSources[0].source_kind, 'tool_model_result');
    assert.ok(facts.contentObjects.some((row) => row.id === resultId));
    assert.deepEqual(facts.deliveries, []);
    const beforeRevision = facts.snapshotRevision;
    f.insert('ToolCall', { id: 'list-call', turn_id: 'parent-current-turn', tool_name: 'run_agent', arguments_object_id: f.content('list-args', { action: 'list' }, 'application/json') });
    f.insert('ToolOutcome', { id: 'list-outcome', tool_call_id: 'list-call', status: 'succeeded', content_object_id: f.content('list-result', { data: [] }, 'application/json') });
    assert.equal(f.snapshot().snapshot.snapshotRevision, beforeRevision, 'list/read observation must not invalidate its own next-page cursor');
  } finally { f.close(); }
});

test('consumed but unhandled delivery retains dead-letter wake state and failure detail in the same snapshot', () => {
  const f = fixture();
  try {
    f.child('worker');
    f.insert('AnswerSubmission', { id: 'submission', answer_bridge_id: 'worker-bridge', turn_id: 'worker-turn', interrupted: 0n });
    f.insert('AnswerPayload', { id: 'answer-payload', submission_id: 'submission', content_object_id: f.content('answer-body', 'Completed task') });
    f.insert('RuntimeInboxItem', { id: 'inbox', source_kind: 'answer_submission', source_id: 'submission', state: 'available' });
    f.insert('RuntimeDelivery', { id: 'delivery', inbox_item_id: 'inbox', target_conversation_id: 'parent', target_turn_id: 'parent-current-turn', phase: 'current_turn', state: 'consumed' });
    f.insert('PendingTurnInput', { id: 'parent-input', turn_id: 'parent-current-turn', input_kind: 'runtime_delivery', state: 'pending', content_object_id: f.content('runtime-input', { kind: 'runtime_delivery' }, 'application/json') });
    f.insert('RuntimeDeliveryInputLink', { id: 'delivery-input', delivery_id: 'delivery', pending_turn_input_id: 'parent-input', handled_at: null });
    f.insert('RuntimeDeliveryWake', { id: 'wake', delivery_id: 'delivery', state: 'pending', last_error: null });
    const before = f.snapshot().snapshot;
    assert.equal(before.deliveryWakes[0].state, 'pending');
    let changed = false;
    const during = f.snapshot((database, request) => {
      const rows = f.read(database, request);
      if (!changed && request.domain === 'Conversation') {
        changed = true;
        f.writer.prepare('UPDATE runtime_delivery_wake SET state = ?, last_error = ? WHERE id = ?')
          .run('dead_letter', 'Wake retries exhausted', 'wake');
      }
      return rows;
    }).snapshot;
    const after = f.snapshot().snapshot;
    assert.equal(during.deliveryWakes[0].state, 'pending');
    assert.equal(during.snapshotRevision, before.snapshotRevision);
    assert.equal(after.deliveries[0].state, 'consumed');
    assert.equal(after.deliveryInputLinks[0].handled_at, null);
    assert.equal(after.deliveryWakes[0].state, 'dead_letter');
    assert.equal(after.deliveryWakes[0].last_error, 'Wake retries exhausted');
    assert.notEqual(after.snapshotRevision, before.snapshotRevision);
    f.insert('RuntimeDeliveryWake', { id: 'duplicate-wake', delivery_id: 'delivery', state: 'pending' });
    assert.throws(() => f.snapshot(), /at most one RuntimeDeliveryWake relation/);
    assert.equal(f.reader.inTransaction, false);
  } finally { f.close(); }
});

test('streamed model output and unrelated tool-result history do not enter the task snapshot or change its revision', () => {
  const f = fixture();
  try {
    f.child('worker');
    f.insert('Message', { id: 'task-message' });
    f.insert('MessageRevision', { id: 'task-revision', message_id: 'task-message', role: 'user', content_object_id: f.content('task-body', 'Keep this assignment') });
    f.insert('MessageCurrentRevisionLink', { id: 'task-current', message_id: 'task-message', revision_id: 'task-revision' });
    f.insert('MessagePartOfConversation', { id: 'task-membership', message_id: 'task-message', conversation_id: 'worker-conversation' });
    f.insert('MessageTurnLink', { id: 'task-turn-link', message_id: 'task-message', turn_id: 'worker-turn', role: 'input' });
    const before = f.snapshot().snapshot;
    for (const role of ['model', 'tool_result']) {
      const messageId = `stream-${role}`;
      f.insert('Message', { id: messageId });
      f.insert('MessagePartOfConversation', { id: `${messageId}-membership`, message_id: messageId, conversation_id: 'worker-conversation' });
      f.insert('MessageTurnLink', { id: `${messageId}-turn-link`, message_id: messageId, turn_id: 'worker-turn', role });
      f.insert('MessageCurrentRevisionLink', { id: `${messageId}-current`, message_id: messageId, revision_id: `${messageId}-revision-0` });
      for (let index = 0; index < 40; index += 1) {
        const revisionId = `${messageId}-revision-${index}`;
        f.insert('MessageRevision', { id: revisionId, message_id: messageId, role: role === 'model' ? 'assistant' : 'tool', revision_seq: BigInt(index + 1), content_object_id: f.content(`${revisionId}-body`, `Streamed output chunk ${index}`) });
        f.insert('ContextSegmentSource', { id: `${revisionId}-source`, segment_id: `${revisionId}-segment`, source_kind: 'message_revision', source_id: revisionId });
        f.writer.prepare('UPDATE message_current_revision_link SET revision_id = ? WHERE message_id = ?').run(revisionId, messageId);
        const requests = [];
        const after = f.snapshot((database, request) => { requests.push(request); return f.read(database, request); }).snapshot;
        assert.equal(after.snapshotRevision, before.snapshotRevision);
        assert.deepEqual(after.messageRevisions.map((row) => row.id), ['task-revision']);
        assert.ok(!after.contentObjects.some((row) => String(row.id).startsWith('stream-')));
        assert.ok(!requests.some((request) => request.id === messageId || request.where?.message_id === messageId));
        assert.ok(requests.filter((request) => request.domain === 'MessageTurnLink')
          .every((request) => ['input', 'native_steer'].includes(request.where?.role)));
      }
    }
  } finally { f.close(); }
});

for (const corruption of ['missing-source', 'cross-turn', 'cross-message', 'cycle', 'missing-envelope-body', 'oversized-envelope']) {
  test(`child task facts fail closed and roll back for ${corruption}`, () => {
    const f = fixture();
    try {
      f.child('worker');
      if (corruption === 'missing-source') f.writer.prepare('DELETE FROM tool_call WHERE id = ?').run('worker-source');
      if (corruption === 'cross-turn') {
        f.insert('Conversation', { id: 'unrelated' });
        f.insert('Turn', { id: 'unrelated-turn', conversation_id: 'unrelated' });
        f.writer.prepare('UPDATE child_execution_turn_link SET turn_id = ?').run('unrelated-turn');
      }
      if (corruption === 'cross-message') {
        f.insert('Message', { id: 'bad-message' });
        f.insert('MessageTurnLink', { id: 'bad-turn-message', turn_id: 'worker-turn', message_id: 'bad-message', role: 'input' });
        f.insert('MessagePartOfConversation', { id: 'bad-membership', conversation_id: 'parent', message_id: 'bad-message' });
      }
      if (corruption === 'cycle') f.writer.prepare('UPDATE child_execution_parent_link SET parent_child_execution_id = ?').run('worker');
      if (corruption === 'missing-envelope-body' || corruption === 'oversized-envelope') {
        const envelope = f.content('bad-envelope', { kind: 'input', messageContentObjectId: 'missing', guidance: { position: '1', hold: 'none' } }, TURN_INTENT_ENVELOPE_CONTENT_TYPE);
        f.insert('TurnIntent', { id: 'intent', conversation_id: 'worker-conversation', turn_id: null, state: 'queued' });
        f.insert('TurnIntentRevision', { id: 'revision', intent_id: 'intent', content_object_id: envelope });
        if (corruption === 'oversized-envelope') f.writer.prepare('UPDATE content_object SET byte_length = 65537 WHERE id = ?').run(envelope);
      }
      assert.throws(() => f.snapshot(), /Child task snapshot/);
      assert.equal(f.reader.inTransaction, false);
    } finally { f.close(); }
  });
}
