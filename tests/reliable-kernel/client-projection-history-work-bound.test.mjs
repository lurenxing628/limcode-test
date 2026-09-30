import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import path from 'node:path';
import test from 'node:test';

const require = createRequire(import.meta.url);
const compiledRoot = path.resolve(process.env.LIMCODE_TEST_EXTENSION_ROOT ?? 'dist/extension');
const Database = require('better-sqlite3');
const { createRuntimeSchemaSql } = require(path.join(compiledRoot, 'backend/reliableKernel/schema/domainManifest.js'));
const { executeConversationHistoryProjection, executeClientVisibleMessageHistoryPage, executeClientProjectionSnapshot } =
  require(path.join(compiledRoot, 'backend/reliableKernel/clientProjection.js'));
const { projectChildConversationHistory } = require(path.join(compiledRoot,
  'backend/application/reliableKernel/conversationHistoryProjection.js'));
const { CLIENT_TOOL_EVENT_SUMMARY_LIMIT_PER_CALL: eventLimit } = require(path.join(compiledRoot, 'backend/reliableKernel/clientFeedBounds.js'));
const NOW = '2026-09-01T00:00:00.000Z';

function fixture(t) {
  const db = new Database(':memory:');
  for (const sql of createRuntimeSchemaSql()) db.exec(sql);
  db.defaultSafeIntegers(true);
  db.pragma('foreign_keys=ON');
  t.after(() => db.close());
  const insert = (table, row) => db.prepare(`INSERT INTO ${table} (${Object.keys(row).join(',')}) VALUES (${Object.keys(row).map(() => '?').join(',')})`).run(...Object.values(row));
  const conversation = id => insert('conversation', { id, title: id, status: 'active', created_at: NOW, updated_at: NOW });
  insert('content_object', { id: 'content', content_type: 'text/plain', sha256: 'hash', byte_length: 2, storage_key: 'unused', created_at: NOW });
  const message = (id, conversationId, seq, role = 'user', deleted = false) => {
    insert('message', { id, created_at: NOW, updated_at: NOW, deleted_at: deleted ? NOW : null });
    insert('message_revision', { id: `r-${id}`, message_id: id, revision_seq: 1, role, content_object_id: 'content', created_at: NOW });
    insert('message_current_revision_link', { id: `c-${id}`, message_id: id, revision_id: `r-${id}`, updated_at: NOW });
    insert('message_part_of_conversation', { id: `p-${id}`, conversation_id: conversationId, message_id: id, message_seq: seq, created_at: NOW });
  };
  const turn = (id, conversationId, status = 'terminated') => insert('turn', { id, conversation_id: conversationId, status, created_at: NOW, updated_at: NOW, terminal_at: status === 'active' ? null : NOW });
  const queries = [];
  const prepare = db.prepare.bind(db);
  db.prepare = sql => { queries.push(sql); return prepare(sql); };
  return { db, insert, conversation, message, turn, queries };
}
const sidebar = db => executeConversationHistoryProjection(db, { scopeKind: 'all', pageIndex: 0, limit: 50 });
const plan = (db, sql, params) => db.prepare(`EXPLAIN QUERY PLAN ${sql}`).all(params).map(row => row.detail).join('\n');

// Count membership predicates in the actual prepared production SQL. No elapsed-time threshold:
// appended visible history must not increase first/latest endpoint work or old-prefix work.
function visited(db, sql, params) {
  let count = 0;
  const instrumented = sql.replace('WHERE membership.conversation_id =',
    'WHERE visit_membership(membership.message_id) AND membership.conversation_id =');
  // better-sqlite3 needs the declared arity to match the probe argument.
  db.function('visit_membership', (_id) => { count += 1; return 1; });
  db.prepare(instrumented).all(params);
  return count;
}

test('sidebar endpoint seeks preserve current revisions, deleted/hidden filtering, empty conversations and ownership', t => {
  const f = fixture(t);
  f.conversation('a'); f.conversation('empty'); f.conversation('hidden'); f.conversation('foreign');
  f.message('deleted-first', 'a', 1, 'user', true);
  f.message('system', 'a', 2, 'system');
  f.message('first', 'a', 7, 'user');
  f.message('last', 'a', 999, 'model');
  f.message('deleted-last', 'a', 1000, 'model', true);
  f.message('hidden-last', 'a', 1001, 'tool');
  f.message('hidden-only', 'hidden', 1, 'system');
  f.message('foreign-message', 'foreign', 9999, 'user');
  f.insert('message_revision', { id: 'first-edited', message_id: 'first', revision_seq: 2, role: 'user', content_object_id: 'content', created_at: NOW });
  f.db.prepare('UPDATE message_current_revision_link SET revision_id=? WHERE message_id=?').run('first-edited', 'first');
  const result = sidebar(f.db);
  assert.equal(result.titleTargets.find(row => row.conversationId === 'a').revisionId, 'first-edited');
  assert.equal(result.previewTargets.find(row => row.conversationId === 'a').revisionId, 'r-last');
  for (const id of ['empty', 'hidden']) {
    assert.ok(!result.titleTargets.some(row => row.conversationId === id));
    assert.ok(!result.previewTargets.some(row => row.conversationId === id));
  }
  assert.equal(result.messageSummaries.find(row => row.conversation_id === 'a').message_count, 2n);
});

test('sidebar endpoint membership visits stay constant as visible history grows', t => {
  const f = fixture(t); f.conversation('a');
  f.message('first', 'a', 1); f.message('last', 'a', 2, 'model');
  sidebar(f.db);
  const queries = f.queries.filter(sql => sql.includes('SELECT conversation.id AS conversation_id, revision.id AS revision_id'));
  assert.equal(queries.length, 2);
  const before = queries.map(sql => visited(f.db, sql, { conversation0: 'a' }));
  f.db.transaction(() => { for (let i = 3; i <= 3000; i++) f.message(`m-${i}`, 'a', i, i % 2 ? 'user' : 'model'); })();
  const after = queries.map(sql => visited(f.db, sql, { conversation0: 'a' }));
  assert.deepEqual(after, before);
  assert.ok(after.every(count => count <= 2));
  for (const sql of queries) {
    const details = plan(f.db, sql, { conversation0: 'a' });
    assert.match(details, /SEARCH membership USING INDEX ux_message_part_of_conversation_01/);
    assert.doesNotMatch(details, /TEMP B-TREE|CO-ROUTINE/);
  }
});

test('old visible history pages keep absolute ordinals and exclude the newer suffix from ranking', t => {
  const f = fixture(t); f.conversation('a'); f.conversation('foreign');
  for (let i = 1; i <= 12; i++) f.message(`m-${i}`, 'a', i * 10, i === 3 ? 'system' : 'user', i === 6);
  f.message('foreign', 'foreign', 15);
  const input = { conversationId: 'a', beforeMessageSeq: '100', beforeId: 'm-10', limit: 4 };
  const read = () => executeClientVisibleMessageHistoryPage(f.db, input, {});
  const before = read();
  assert.deepEqual(before.records.Message.map(row => [row.id, row.display_seq]),
    [['m-5', '4'], ['m-7', '5'], ['m-8', '6'], ['m-9', '7']]);
  const sql = f.queries.find(sql => sql.includes('WITH page AS MATERIALIZED') && sql.includes('@beforeMessageSeq'));
  const params = { conversationId: 'a', beforeMessageSeq: 100n, beforeId: 'm-10', limit: 5n };
  const workBefore = visited(f.db, sql, params);
  f.db.transaction(() => { for (let i = 13; i <= 3000; i++) f.message(`m-${i}`, 'a', i * 10); })();
  assert.deepEqual(read(), before);
  assert.equal(visited(f.db, sql, params), workBefore);
  assert.match(plan(f.db, sql, params), /membership.*conversation_id=\? AND message_seq<\?/);
  // Cursor IDs on either side of the stored ID retain the existing lexicographic tie rule.
  assert.equal(executeClientVisibleMessageHistoryPage(f.db, { ...input, beforeId: 'z' }, {}).records.Message.at(-1).id, 'm-10');
  const oldest = executeClientVisibleMessageHistoryPage(f.db, { ...input, beforeMessageSeq: '20', beforeId: 'm-2' }, {});
  assert.deepEqual(oldest.records.Message.map(row => [row.id, row.display_seq]), [['m-1', '1']]);
  assert.equal(oldest.hasMore, false);
  const nearEnd = executeClientVisibleMessageHistoryPage(f.db, {
    ...input, beforeMessageSeq: '29900', beforeId: 'm-2990'
  }, {});
  assert.deepEqual(nearEnd.records.Message.map(row => [row.id, row.display_seq]),
    [['m-2986', '2984'], ['m-2987', '2985'], ['m-2988', '2986'], ['m-2989', '2987']]);
  assert.ok(nearEnd.hasMore);
  assert.match(plan(f.db, sql, params), /MATERIALIZE page/);
});

test('sidebar returns only active and exact referenced Turns, preserving terminal answer delivery status', t => {
  const f = fixture(t); f.conversation('child'); f.conversation('parent');
  f.turn('parent-target', 'parent'); f.turn('child-active', 'child', 'active');
  f.db.transaction(() => { for (let i = 0; i < 3000; i++) f.turn(`old-${i}`, 'parent'); })();
  f.insert('conversation_origin_link', { id: 'origin', conversation_id: 'child', source_conversation_id: 'parent', source_turn_id: null, source_tool_call_id: null, source_message_revision_id: null, created_at: NOW });
  f.insert('child_execution', { id: 'execution', child_conversation_id: 'child', status: 'closed', created_at: NOW, updated_at: NOW });
  f.insert('answer_bridge', { id: 'bridge', child_execution_id: 'execution', current_submission_id: 'answer', status: 'submitted', created_at: NOW, updated_at: NOW });
  f.insert('runtime_inbox_item', { id: 'inbox', dedupe_key: 'inbox', source_kind: 'answer_submission', source_id: 'answer', state: 'ready', created_at: NOW, updated_at: NOW });
  f.insert('runtime_delivery', { id: 'delivery', inbox_item_id: 'inbox', target_conversation_id: 'parent', target_turn_id: 'parent-target', phase: 'input', attempt_seq: 1, retry_of_delivery_id: null, state: 'consumed', failure_reason: null, created_at: NOW, updated_at: NOW });
  const read = () => sidebar(f.db);
  const facts = read();
  assert.deepEqual(facts.turns.map(row => row.id).sort(), ['child-active', 'parent-target']);
  assert.equal(projectChildConversationHistory('child', { ...facts, activeTurnLinks: facts.activeChildTurnLinks }).state, 'delivery_failed');
  const activeSql = f.queries.find(sql => sql.includes("status = 'active'") && sql.includes('FROM turn'));
  assert.match(plan(f.db, activeSql, { conversation0: 'parent', conversation1: 'child' }), /ix_turn_02 \(status=\?\)/);
  f.insert('runtime_delivery_input_link', { id: 'input', delivery_id: 'delivery', pending_turn_input_id: 'pending', handled_at: NOW, created_at: NOW, updated_at: NOW });
  const handled = read();
  assert.equal(projectChildConversationHistory('child', { ...handled, activeTurnLinks: handled.activeChildTurnLinks }).state, 'completed');
  f.insert('child_execution_active_turn_link', { id: 'active-link', child_execution_id: 'execution', turn_id: 'child-active', updated_at: NOW });
  f.insert('execution_lease', { id: 'lease', conversation_id: 'child', turn_id: 'child-active', owner_id: 'owner',
    host_boot_id: 'host', generation: 1, acquired_at: NOW, expires_at: '2026-09-02T00:00:00.000Z' });
  const running = read();
  assert.equal(projectChildConversationHistory('child', { ...running, activeTurnLinks: running.activeChildTurnLinks }).state, 'running');

});

test('old pinned tool sources retain absolute ranks without scanning a newer suffix or reranking visible sources', t => {
  const f = fixture(t); f.conversation('a'); f.turn('turn', 'a');
  for (let i = 1; i <= 220; i++) f.message(`m-${i}`, 'a', i, i === 2 ? 'system' : 'model', i === 3);
  f.insert('model_request', { id: 'request', turn_id: 'turn', request_seq: 1, status: 'terminated', terminal_state: 'completed',
    provider_id: 'provider', model_id: 'model', context_window_tokens: 1000, compression_threshold_tokens: 800,
    estimated_context_tokens: 10, authority_snapshot_id: 'authority', settings_snapshot_object_id: null,
    recipe_object_id: 'content', usage_json: null, stream_stats_json: null, created_at: NOW, updated_at: NOW });
  const call = (id, messageId, seq) => {
    f.insert('tool_call', { id, turn_id: 'turn', call_seq: seq, tool_name: 'test', status: 'proposed', arguments_object_id: 'content', created_at: NOW, updated_at: NOW });
    f.insert('tool_call_source_link', { id: `source-${id}`, tool_call_id: id, model_request_id: 'request', message_id: messageId,
      provider_call_id: null, provider_ordinal: seq, batch_id: 'batch', batch_ordinal: seq, thought_signature: null, created_at: NOW });
  };
  call('old-call', 'm-5', 1); call('visible-call', 'm-220', 2);
  const read = () => executeClientProjectionSnapshot(f.db, 'a', 1n, { readVerifiedBytes: () => Buffer.from('{}') });
  const first = read();
  const messages = first.snapshot.activeConversationWindow.messages;
  assert.equal(messages.find(row => row.id === 'm-5').display_seq, 3n);
  const sql = f.queries.find(sql => sql.includes('WITH visible_messages AS') && sql.includes('@message0'));
  assert.ok(sql);
  assert.ok(!sql.includes('@message1'), 'only the old source should be reranked');
  const params = { conversationId: 'a', message0: 'm-5' };
  const oldWork = visited(f.db, sql, params);
  f.db.transaction(() => { for (let i = 221; i <= 1000; i++) f.message(`m-${i}`, 'a', i, 'model'); })();
  assert.equal(visited(f.db, sql, params), oldWork);
  const details = plan(f.db, sql, params);
  assert.match(details, /membership.*conversation_id=\? AND message_seq<\?/);
  assert.equal(read().snapshot.activeConversationWindow.messages.find(row => row.id === 'm-5').display_seq, 3n);
});

test('tool-event and child-turn tails seek bounded rows per selected owner across chunks', t => {
  const f = fixture(t); f.conversation('a'); f.turn('root', 'a');
  const ownerCount = 352; // Cross both helpers' 350-ID chunk boundary.
  f.db.transaction(() => {
    for (let i = 0; i < ownerCount; i++) {
      const call = `call-${String(i).padStart(3, '0')}`;
      const child = `child-${String(i).padStart(3, '0')}`;
      f.insert('tool_call', { id: call, turn_id: 'root', call_seq: i + 1, tool_name: 'test', status: 'proposed', arguments_object_id: 'content', created_at: NOW, updated_at: NOW });
      f.conversation(child);
      f.insert('child_execution', { id: child, child_conversation_id: child, status: 'closed', created_at: NOW, updated_at: NOW });
      f.insert('child_execution_parent_link', { id: `parent-${child}`, child_execution_id: child, source_tool_call_id: call, parent_child_execution_id: null, parent_turn_id: 'root', created_at: NOW });
      f.turn(`turn-${child}`, child);
      // First owner has deep history, second is empty; the rest have one tail row.
      const rows = i === 0 ? 2000 : i === 1 ? 0 : 1;
      for (let j = 1; j <= rows; j++) {
        f.insert('tool_call_event', { id: `event-${i}-${j}`, tool_call_id: call, event_seq: j * 2, event_kind: 'progress', content_object_id: null, created_at: NOW });
        if (j > 1) f.turn(`turn-${child}-${j}`, child);
        f.insert('child_execution_turn_link', { id: `link-${i}-${j}`, child_execution_id: child, turn_seq: j * 3, turn_id: j === 1 ? `turn-${child}` : `turn-${child}-${j}`, created_at: NOW });
      }
    }
  })();
  const result = executeClientProjectionSnapshot(f.db, 'a', 1n, { readVerifiedBytes: () => Buffer.from('{}') }).snapshot;
  const events = result.activeToolAndInteractionSummary.toolCallEvents;
  const links = result.subagentDeliverySummary.childExecutionTurnLinks;
  assert.deepEqual(events.filter(row => row.tool_call_id === 'call-000').map(row => row.event_seq),
    Array.from({ length: eventLimit }, (_, i) => BigInt((2001 - eventLimit + i) * 2)));
  assert.equal(events.filter(row => row.tool_call_id === 'call-001').length, 0);
  assert.equal(events.length, eventLimit + ownerCount - 2);
  assert.equal(links.find(row => row.child_execution_id === 'child-000').turn_seq, 6000n);
  assert.equal(links.length, ownerCount - 1);
  assert.ok(links.some(row => row.child_execution_id === 'child-351'));
  const eventSql = f.queries.find(sql => sql.includes('FROM tool_call AS call') && sql.includes('JOIN tool_call_event AS event'));
  const linkSql = f.queries.find(sql => sql.includes('JOIN child_execution_turn_link AS link ON link.id ='));
  assert.ok(eventSql && linkSql);
  const eventParams = { eventLimit: BigInt(eventLimit) };
  const childParams = {};
  for (let i = 0; i < 350; i++) {
    eventParams[`tool${i}`] = `call-${String(i).padStart(3, '0')}`;
    childParams[`child${i}`] = `child-${String(i).padStart(3, '0')}`;
  }
  for (const [sql, params, owner, index, expected] of [
    [eventSql, eventParams, 'tool_call_id', 'ux_tool_call_event_01', eventLimit + 348],
    [linkSql, childParams, 'child_execution_id', 'ux_child_execution_turn_link_01', 349]
  ]) {
    let inspected = 0;
    f.db.function('visit_tail', (_id) => { inspected++; return 1; });
    f.db.prepare(sql.replace(`WHERE recent.${owner} =`, `WHERE visit_tail(recent.id) AND recent.${owner} =`)).all(params);
    assert.equal(inspected, expected, 'tail work depends on returned rows, not the 2000-row history');
    const details = plan(f.db, sql, params);
    assert.match(details, new RegExp(`SEARCH recent USING INDEX ${index}`));
    assert.doesNotMatch(details, /CO-ROUTINE/);
  }
});
