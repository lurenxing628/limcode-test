import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import path from 'node:path';
import test from 'node:test';

const require = createRequire(import.meta.url);
const compiledRoot = path.resolve(process.env.LIMCODE_TEST_EXTENSION_ROOT ?? 'dist/extension');
const Database = require('better-sqlite3');
const { createRuntimeSchemaSql } = require(path.join(compiledRoot, 'backend/reliableKernel/schema/domainManifest.js'));
const { projectCompressionBlockRecord, executeClientProjectionSnapshot } = require(path.join(compiledRoot, 'backend/reliableKernel/clientProjection.js'));
const { CLIENT_ACTIVE_RECORD_LIMIT_PER_TYPE } = require(path.join(compiledRoot, 'backend/reliableKernel/clientFeedBounds.js'));
const { attachRuntimeStatementCache, detachRuntimeStatementCache } = require(path.join(compiledRoot, 'backend/reliableKernel/runtimeStatementCache.js'));
const NOW = '2026-09-29T00:00:00.000Z';
const noContent = { readVerifiedBytes() { throw new Error('Compression summaries must only read metadata.'); } };

function fixture(t) {
  const db = new Database(':memory:');
  db.defaultSafeIntegers(true);
  db.pragma('foreign_keys = ON');
  for (const sql of createRuntimeSchemaSql()) db.exec(sql);
  t.after(() => { detachRuntimeStatementCache(db); db.close(); });
  const prepareInsert = (table, columns) => db.prepare(
    `INSERT INTO ${table} (${columns}) VALUES (${columns.split(',').map(() => '?').join(',')})`
  );
  const insert = {
    conversation: prepareInsert('conversation', 'id,title,status,created_at,updated_at'),
    message: prepareInsert('message', 'id,created_at,updated_at,deleted_at'),
    revision: prepareInsert('message_revision', 'id,message_id,revision_seq,role,content_object_id,created_at'),
    membership: prepareInsert('message_part_of_conversation', 'id,conversation_id,message_id,message_seq,created_at'),
    currentRevision: prepareInsert('message_current_revision_link', 'id,message_id,revision_id,updated_at'),
    segment: prepareInsert('context_segment', 'id,content_object_id,segment_kind,created_at'),
    provenance: prepareInsert('context_segment_source', 'id,segment_id,source_kind,source_id,source_revision,created_at'),
    block: prepareInsert('compression_block', 'id,conversation_id,status,authority_snapshot_id,title_object_id,summary_object_id,created_at,updated_at'),
    source: prepareInsert('compression_block_source', 'id,compression_block_id,segment_id,position,created_at')
  };
  prepareInsert('content_object', 'id,content_type,sha256,byte_length,storage_key,created_at')
    .run('content', 'text/plain', 'a'.repeat(64), 7n, 'fixture', NOW);
  const f = {
    db,
    conversation(id) { insert.conversation.run(id, id, 'active', NOW, NOW); },
    segment(id, kind = 'message') { insert.segment.run(id, 'content', kind, NOW); return id; },
    message(id, conversationId, sequence, { sharedSegment, deleted = false, edited = false } = {}) {
      const segmentId = sharedSegment ?? f.segment(`segment-${id}`);
      insert.message.run(id, NOW, NOW, deleted ? NOW : null);
      insert.revision.run(`revision-${id}`, id, 0n, 'user', 'content', NOW);
      insert.membership.run(`membership-${id}`, conversationId, id, BigInt(sequence), NOW);
      insert.provenance.run(`provenance-${id}`, segmentId, 'message_revision', `revision-${id}`, 0n, NOW);
      if (edited) insert.revision.run(`edited-${id}`, id, 1n, 'user', 'content', NOW);
      insert.currentRevision.run(`current-${id}`, id, `${edited ? 'edited' : 'revision'}-${id}`, NOW);
      return segmentId;
    },
    block(id, { conversationId = 'main', status = 'enabled', createdAt = NOW } = {}) {
      insert.block.run(id, conversationId, status, 'authority', 'content', 'content', createdAt, createdAt);
      return id;
    },
    source(blockId, segmentId, position, id = `${blockId}-${segmentId}-${position}`) {
      insert.source.run(id, blockId, segmentId, BigInt(position), NOW);
    },
    provenance(segmentId, sourceKind, sourceId) {
      insert.provenance.run(`extra-${segmentId}-${sourceId}`, segmentId, sourceKind, sourceId, 0n, NOW);
    }
  };
  f.conversation('main');
  f.conversation('other');
  return f;
}

function snapshot(db, conversationId = 'main') {
  const result = executeClientProjectionSnapshot(db, conversationId, 42n, noContent);
  assert.equal(result.snapshotCommitSeq, '42');
  return result.snapshot.activeConversationWindow.compressionBlocks;
}

function assertSummary(f, id, sourceCount, anchor) {
  const row = projectCompressionBlockRecord(f.db, id);
  assert.equal(row.source_count, BigInt(sourceCount));
  assert.equal(row.anchor_message_id, anchor);
  assert.deepEqual(snapshot(f.db, row.conversation_id).find(block => block.id === id), row);
  return row;
}

test('compression summaries preserve empty, non-message and nested-only sources and missing-block errors', t => {
  const f = fixture(t);
  f.block('empty');
  f.block('non-message');
  const system = f.segment('system', 'system');
  f.provenance(system, 'system', 'system-source');
  f.source('non-message', system, 0);
  const nested = f.segment('nested', 'compression');
  f.provenance(nested, 'compression_block', 'empty');
  f.block('nested-only');
  f.source('nested-only', nested, 0);
  assertSummary(f, 'empty', 0, null);
  assertSummary(f, 'non-message', 1, null);
  assertSummary(f, 'nested-only', 1, null);
  assert.throws(() => projectCompressionBlockRecord(f.db, 'missing'), /cannot resolve its bounded summary/);
  assert.deepEqual(snapshot(f.db, 'missing'), []);
  assert.deepEqual(snapshot(f.db, null), []);
  assert.equal(f.db.inTransaction, false);
});

test('compression anchors use source position then source id, not message order, and retain frozen revisions', t => {
  const f = fixture(t);
  const latestMessage = f.message('latest-message', 'main', 100);
  const earlierMessage = f.message('earlier-message', 'main', 1, { edited: true, deleted: true });
  const foreign = f.message('foreign-message', 'other', 1);
  const system = f.segment('system', 'system');
  f.provenance(system, 'system', 'instruction');
  f.block('ordered', { status: 'disabled' });
  f.source('ordered', latestMessage, 1, 'z-low-position');
  f.source('ordered', latestMessage, 5, 'a-tied-position');
  f.source('ordered', earlierMessage, 5, 'z-tied-position');
  f.source('ordered', foreign, 6);
  f.source('ordered', system, 7);
  assert.equal(assertSummary(f, 'ordered', 5, 'earlier-message').status, 'disabled');
  // A foreign-only range must not anchor a card in another Conversation.
  f.block('foreign-only');
  f.source('foreign-only', foreign, 0);
  assertSummary(f, 'foreign-only', 1, null);
});

test('shared segment aliases stay conversation-local without multiplying the source count', t => {
  const f = fixture(t);
  const shared = f.segment('shared');
  f.db.transaction(() => {
    for (let index = 0; index < 300; index += 1) {
      const id = `alias-${index}`;
      f.conversation(id);
      f.message(`message-${id}`, id, 1, { sharedSegment: shared });
    }
    f.message('selected-alias', 'main', 1, { sharedSegment: shared });
    f.message('other-alias', 'other', 1, { sharedSegment: shared });
    f.block('shared-main');
    f.block('shared-other', { conversationId: 'other' });
    f.source('shared-main', shared, 0);
    f.source('shared-main', shared, 1);
    f.source('shared-other', shared, 0);
  })();
  for (const analyzed of [false, true]) {
    if (analyzed) f.db.exec('ANALYZE');
    assertSummary(f, 'shared-main', 2, 'selected-alias');
    assertSummary(f, 'shared-other', 1, 'other-alias');
  }
  assert.deepEqual(f.db.pragma('foreign_key_check'), []);
});

test('compression snapshots order by creation time before id and retain disabled blocks', t => {
  const f = fixture(t);
  f.block('z-old', { createdAt: '2026-09-27T00:00:00.000Z' });
  f.block('a-new', { status: 'disabled', createdAt: '2026-09-29T00:00:00.000Z' });
  f.block('b-middle', { createdAt: '2026-09-28T00:00:00.000Z' });
  const rows = snapshot(f.db);
  assert.deepEqual(rows.map(row => row.id), ['z-old', 'b-middle', 'a-new']);
  assert.equal(rows[2].status, 'disabled');
  for (const row of rows) assert.deepEqual(projectCompressionBlockRecord(f.db, row.id), row);
});

test('cached single-block and snapshot statements observe changed sources and statuses', t => {
  const f = fixture(t);
  attachRuntimeStatementCache(f.db);
  f.block('changing');
  assertSummary(f, 'changing', 0, null);
  f.db.transaction(() => {
    const segment = f.message('new-message', 'main', 1);
    f.source('changing', segment, 0);
    f.db.prepare('UPDATE compression_block SET status = ? WHERE id = ?').run('superseded', 'changing');
  })();
  assert.equal(assertSummary(f, 'changing', 1, 'new-message').status, 'superseded');
  f.db.prepare('DELETE FROM compression_block WHERE id = ?').run('changing');
  assert.deepEqual(snapshot(f.db), []);
  assert.throws(() => projectCompressionBlockRecord(f.db, 'changing'), /cannot resolve its bounded summary/);
  assert.equal(f.db.inTransaction, false);
});

for (const analyzed of [false, true]) {
  test(`compression snapshot limits source aggregation before historical expansion (ANALYZE=${analyzed})`, t => {
    const f = fixture(t);
    const limit = CLIENT_ACTIVE_RECORD_LIMIT_PER_TYPE;
    const blockCount = limit * 3;
    const sourceCount = 30;
    const messageCount = 17000;
    const blockId = i => `block-${String(i).padStart(5, '0')}`;
    f.db.transaction(() => {
      for (let i = 0; i < messageCount; i += 1) f.message(`m${i}`, 'main', i + 1);
      // Reverse insertion order and tied timestamps exercise the id tie-break at the window edge.
      for (let i = blockCount - 1; i >= 0; i -= 1) {
        const id = f.block(blockId(i));
        for (let j = 0; j < sourceCount; j += 1) {
          f.source(id, `segment-m${(i * sourceCount + j) % messageCount}`, j);
        }
      }
      f.block('newer-in-other-conversation', { conversationId: 'other', createdAt: '2026-09-30T00:00:00.000Z' });
    })();
    if (analyzed) f.db.exec('ANALYZE');
    const statements = [];
    let sourceVisits = 0;
    f.db.function('projection_source_visit', value => { sourceVisits += 1; return value; });
    const recording = {
      exec: sql => f.db.exec(sql),
      prepare(sql) {
        if (!sql.includes('AS anchor_message_id')) return f.db.prepare(sql);
        statements.push(sql);
        // Count actual aggregate inputs, not wall-clock time. Keep the production query otherwise
        // unchanged; a NULL input still returns NULL so empty-block COUNT semantics are preserved.
        assert.equal((sql.match(/COUNT\(source\.id\)/g) ?? []).length, 1);
        return f.db.prepare(sql.replace('COUNT(source.id)', 'COUNT(projection_source_visit(source.id))'));
      }
    };
    const rows = snapshot(recording);
    assert.deepEqual(rows.map(row => row.id), Array.from({ length: limit }, (_, i) => blockId(blockCount - limit + i)));
    for (const [offset, row] of rows.entries()) {
      const index = blockCount - limit + offset;
      assert.equal(row.source_count, BigInt(sourceCount));
      assert.equal(row.anchor_message_id, `m${(index * sourceCount + sourceCount - 1) % messageCount}`);
    }
    assert.equal(statements.length, 1, 'one SQL query, not one worker query per block');
    const listSql = statements[0];
    const args = { conversationId: 'main', limit: BigInt(limit) };
    const plan = f.db.prepare(`EXPLAIN QUERY PLAN ${listSql}`).all(args).map(row => row.detail);
    assert.ok(plan.some(detail => /SEARCH anchor_source\b.*compression_block_id=\?/.test(detail)), plan.join('\n'));
    assert.ok(plan.some(detail => /SEARCH segment_source\b.*segment_id=\?/.test(detail)), plan.join('\n'));
    t.diagnostic(`blocks=${blockCount}, returned=${rows.length}, source aggregation visits=${sourceVisits}, expected=${limit * sourceCount}`);
    assert.equal(sourceVisits, limit * sourceCount, 'historical blocks outside the returned window must not expand their sources');

    sourceVisits = 0;
    assert.deepEqual(projectCompressionBlockRecord(recording, rows[0].id), rows[0]);
    assert.equal(sourceVisits, sourceCount);
    const singlePlan = f.db.prepare(`EXPLAIN QUERY PLAN ${statements[1]}`)
      .all({ blockId: rows[0].id }).map(row => row.detail);
    assert.ok(singlePlan.some(detail => /SEARCH anchor_source\b.*compression_block_id=\?/.test(detail)), singlePlan.join('\n'));
    assert.ok(singlePlan.some(detail => /SEARCH segment_source\b.*segment_id=\?/.test(detail)), singlePlan.join('\n'));
    assert.deepEqual(f.db.pragma('foreign_key_check'), []);
    assert.equal(f.db.inTransaction, false);
  });
}
