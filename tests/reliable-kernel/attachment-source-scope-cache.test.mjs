import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
const require = createRequire(import.meta.url);
const compiled = path.resolve(process.env.LIMCODE_TEST_EXTENSION_ROOT ?? 'dist/extension');
const kernel = name => require(path.join(compiled, 'backend/reliableKernel', `${name}.js`));
const Database = require('better-sqlite3');
const { AttachmentProjectionScopeCache: Cache, readAttachmentScopeSnapshot: fenced } = kernel('attachmentProjectionScopeCache');
const { readAttachmentProjectionSegments: read, readAttachmentProjectionLinks: links } = kernel('attachmentProjectionSnapshot');
const { createRuntimeSchemaSql } = kernel('schema/domainManifest');
const NOW = '2026-10-03T00:00:00Z';
function fixture(t, disk = false) {
  const dir = disk ? fs.mkdtempSync(path.join(os.tmpdir(), 'attachment-scope-')) : undefined;
  const file = dir ? path.join(dir, 'runtime.sqlite') : ':memory:';
  const db = new Database(file); db.defaultSafeIntegers(true); db.pragma('foreign_keys=ON');
  if (disk) db.pragma('journal_mode=WAL');
  for (const sql of createRuntimeSchemaSql()) db.exec(sql);
  const insert = (table, row) => db.prepare(`INSERT INTO ${table} (${Object.keys(row).join(',')}) VALUES (${Object.keys(row).map(() => '?').join(',')})`).run(...Object.values(row));
  const cache = new Cache();
  const f = { db, file, cache, insert, connections: [],
    conversation(id) { insert('conversation', { id, title: id, status: 'active', created_at: NOW, updated_at: NOW }); },
    segment(id) { insert('context_segment', { id, content_object_id: 'content', segment_kind: 'message', created_at: NOW }); },
    source(id, segment, kind, owner, revision = 0n) { insert('context_segment_source', { id, segment_id: segment, source_kind: kind, source_id: owner, source_revision: revision, created_at: NOW }); },
    message(id, conversation, segment, source = `source-${id}`) {
      insert('message', { id, created_at: NOW, updated_at: NOW, deleted_at: null });
      insert('message_revision', { id: `revision-${id}`, message_id: id, revision_seq: 0n, role: 'user', content_object_id: 'content', created_at: NOW });
      if (conversation !== null) insert('message_part_of_conversation', { id: `member-${id}`, conversation_id: conversation, message_id: id, message_seq: BigInt(++f.sequence), created_at: NOW });
      f.source(source, segment, 'message_revision', `revision-${id}`);
    },
    turn(id, conversation) { insert('turn', { id, conversation_id: conversation, status: 'terminated', created_at: NOW, updated_at: NOW, terminal_at: NOW }); },
    call(id, turn) { insert('tool_call', { id, turn_id: turn, call_seq: BigInt(++f.sequence), tool_name: 'read', status: 'terminal', arguments_object_id: 'content', created_at: NOW, updated_at: NOW }); },
    sequence: 0,
    read(ids, owner = 'main') { return db.transaction(() => read(db, owner, ids, cache))(); }
  };
  insert('content_object', { id: 'content', content_type: 'text/plain', sha256: 'a'.repeat(64), byte_length: 1n, storage_key: 'fixture', created_at: NOW });
  f.conversation('main'); f.conversation('other');
  t.after(() => { for (const connection of f.connections) connection.close(); db.close(); if (dir) fs.rmSync(dir, { recursive: true, force: true }); });
  return f;
}
function facts(snapshot) {
  return Object.fromEntries(Object.entries(snapshot).filter(([key]) => key !== 'examinedSourceCount')
    .map(([key, rows]) => [key, [...rows].sort((a, b) => String(a.id).localeCompare(String(b.id)))]));
}

test('complete alias proofs reuse raw PKs, exact owners and fresh attachment links; bad new foreign evidence still rejects', t => {
  const f = fixture(t); f.segment('shared'); f.segment('empty');
  f.conversation(' main ');
  f.message('selected', 'main', 'shared', ' source with whitespace ');
  f.message('foreign', 'other', 'shared'); f.message('untrimmed-owner', ' main ', 'shared');
  const cold = f.read(['shared', 'empty']); const warm = f.read(['shared', 'empty']);
  assert.deepEqual(facts(warm), facts(cold)); assert.equal(cold.examinedSourceCount, 3); assert.equal(warm.examinedSourceCount, 1);
  assert.deepEqual(warm.sources.map(row => row.id), [' source with whitespace ']);
  f.insert('attachment', { id: 'late', sha256: 'b'.repeat(64), byte_length: 1n, mime_type: 'text/plain', name: 'late.txt', storage_mode: 'managed', content_object_id: null, created_at: NOW });
  assert.deepEqual(links(f.db, ['revision-selected']).links, []);
  f.insert('attachment_link', { id: 'late-link', message_revision_id: 'revision-selected', attachment_id: 'late', position: 0n, created_at: NOW });
  assert.equal(links(f.db, ['revision-selected']).links.length, 1);
  f.cache.beforeMutation({ kind: 'insert', domain: 'ContextSegmentSource', row: { segment_id: 'shared' } });
  f.source('bad-foreign', 'shared', 'tool_call', 'deleted-alias', -1n);
  assert.throws(() => f.read(['shared']), /source_revision must be a non-negative/);
  assert.equal(f.cache.inspect().candidateBytes, 0);
});

test('incomplete aliases are never cached; owner changes, cascades and partial-hit fallback reread full evidence', t => {
  const f = fixture(t); f.segment('s'); f.message('main-message', 'main', 's');
  f.source('missing-tool-source', 's', 'tool_call', 'later-call');
  f.read(['s']); assert.equal(f.cache.inspect().entries, 0);
  f.turn('other-turn', 'other'); f.call('later-call', 'other-turn');
  f.read(['s']); assert.equal(f.cache.inspect().entries, 1);
  f.cache.beforeMutation({ kind: 'update', domain: 'ToolCall', id: 'later-call', patch: { turn_id: 'main-turn' } });
  f.turn('main-turn', 'main'); f.db.prepare('UPDATE tool_call SET turn_id=? WHERE id=?').run('main-turn', 'later-call');
  assert.equal(f.read(['s']).sources.length, 2);
  f.cache.beforeMutation({ kind: 'update', domain: 'Turn', id: 'main-turn', patch: { conversation_id: 'other' } });
  f.db.prepare('UPDATE turn SET conversation_id=? WHERE id=?').run('other', 'main-turn');
  assert.equal(f.read(['s']).sources.length, 1);
  // Deliberately omit the invalidation to exercise the defensive same-snapshot fallback itself.
  f.db.prepare('DELETE FROM context_segment_source WHERE id=?').run('source-main-message');
  const fallback = f.read(['s']); assert.equal(fallback.sources.length, 0); assert.equal(fallback.messageRevisions.length, 0);
  assert.equal(f.cache.inspect().fallbacks, 1);
  f.read(['s']); f.cache.beforeMutation({ kind: 'delete', domain: 'Conversation', id: 'other' });
  f.db.prepare('DELETE FROM conversation WHERE id=?').run('other');
  assert.equal(f.read(['s']).sources.length, 0); assert.equal(f.cache.inspect().entries, 0);
  f.segment('memberless'); f.message('memberless', null, 'memberless'); f.read(['memberless']);
  assert.equal(f.cache.inspect().entries, 0);
  f.insert('message_part_of_conversation', { id: 'completed-member', message_id: 'memberless', conversation_id: 'main', message_seq: 100n, created_at: NOW });
  assert.equal(f.read(['memberless']).sources.length, 1);
});

test('external commits before and after the actual reader snapshot bypass publication, then refresh on the next read', t => {
  const f = fixture(t, true); f.segment('s'); f.message('main-message', 'main', 's');
  const reader = new Database(f.file, { readonly: true }); reader.defaultSafeIntegers(true);
  const external = new Database(f.file); external.defaultSafeIntegers(true);
  f.connections.push(external, reader);
  const anchor = () => { reader.prepare('SELECT singleton FROM root_binding').get(); };
  const project = establish => fenced(reader, f.db, f.cache, establish ?? anchor, cache => read(reader, 'main', ['s'], cache));
  project(); project(); assert.equal(f.cache.inspect().hits, 1);
  const update = value => external.prepare('UPDATE message_part_of_conversation SET conversation_id=? WHERE id=?').run(value, 'member-main-message');
  assert.equal(project(() => { update('other'); anchor(); }).sources.length, 0);
  assert.equal(f.cache.inspect().entries, 0); assert.equal(f.cache.inspect().snapshotRaces, 1);
  project();
  assert.equal(project(() => { anchor(); update('main'); }).sources.length, 0, 'established snapshot remains old');
  assert.equal(f.cache.inspect().entries, 0); assert.equal(f.cache.inspect().snapshotRaces, 2);
  assert.equal(project().sources.length, 1); assert.equal(project().sources.length, 1);
});

test('charged capacity protects admitted entries across oversized scans and fails closed for unknown mutators', () => {
  const cache = new Cache({ bytes: 8_192, entries: 2, sources: 4 });
  for (let pass = 0; pass < 3; pass++) for (let index = 0; index < 10; index++) {
    const id = `s${index}`;
    if (cache.selectedSourceIds(id, 'owner') !== undefined) continue;
    const candidate = cache.candidate(id); candidate?.add(`source${index}`, 'owner'); candidate?.publish();
  }
  assert.equal(cache.inspect().entries, 2); assert.equal(cache.inspect().hits, 4);
  const small = new Cache({ bytes: 2_048, entries: 2, sources: 4 });
  const huge = small.candidate('huge'); huge.add('x'.repeat(10_000), 'owner'); huge.publish();
  assert.equal(small.inspect().entries, 0); assert.equal(small.inspect().candidateBytes, 0);
  assert.equal(cache.inspect().candidateBytes, 0); assert.ok(cache.inspect().peakChargedBytes <= 8_192);
  for (const mutation of [
    { kind: 'update', domain: 'ToolCall', id: 'call', patch: { status: 'terminal', updated_at: NOW } },
    { kind: 'update', domain: 'Turn', id: 'turn', patch: { status: 'terminated', terminal_at: NOW } },
    { kind: 'update', domain: 'Message', id: 'message', patch: { updated_at: NOW } },
    { kind: 'update', domain: 'Conversation', id: 'conversation', patch: { updated_at: NOW } },
    { kind: 'delete', domain: 'ExecutionLease', id: 'lease' }
  ]) cache.beforeMutation(mutation);
  assert.equal(cache.inspect().entries, 2);
  cache.beforeMutation({ kind: 'update', domain: 'ToolCall', id: 'call', patch: { call_seq: 2n } });
  assert.equal(cache.inspect().entries, 0);
  const candidate = cache.candidate('fresh'); candidate.add('pk', null); candidate.publish();
  cache.beforeMutation({ kind: 'insert', domain: 'FutureDomain', row: {} });
  assert.equal(cache.inspect().entries, 0);
  const surrogate = cache.candidate('seg\uFFFD'); surrogate.add('raw-pk', null); surrogate.publish();
  cache.beforeMutation({ kind: 'insert', domain: 'ContextSegmentSource', row: { segment_id: 'seg\uD800' } });
  assert.equal(cache.inspect().entries, 0, 'invalidation follows SQLite UTF-8 identity');
});

test('worker mutation rollback evicts proofs and maintenance instances never publish them', async t => {
  const api = kernel('index'); const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'attachment-scope-worker-'));
  const candidate = await api.resetCandidateRuntimeRoot(dir); let database;
  t.after(async () => { await database?.close(); fs.rmSync(dir, { recursive: true, force: true }); });
  database = await api.RuntimeDatabase.open(candidate.authority, { hostBootId: 'scope-test' });
  const store = api.ContentAddressedStore.forDatabase(candidate.authority, database);
  const content = await store.ingest(database, 'fixture', 'text/plain');
  const repo = name => api.DOMAIN_REPOSITORIES.domain(name);
  await database.transaction([
    repo('ContextSegment').insert({ id: 's', content_object_id: content.id, segment_kind: 'system', created_at: NOW }),
    repo('ContextSegmentSource').insert({ id: 'original', segment_id: 's', source_kind: 'system', source_id: 'original-owner', source_revision: 0n, created_at: NOW })
  ]);
  const readWorker = () => database.attachmentProjectionSegments('main', ['s']);
  await readWorker(); await readWorker(); assert.equal((await database.inspect()).attachmentScopeCache.hits, 1);
  await assert.rejects(database.transaction([
    repo('ContextSegmentSource').insert({ id: 'rolled-back', segment_id: 's', source_kind: 'system', source_id: 'rolled-back-owner', source_revision: 0n, created_at: NOW }),
    repo('ContextSegment').assert('absent', { segment_kind: 'system' })
  ]));
  assert.equal((await database.inspect()).attachmentScopeCache.entries, 0);
  assert.equal((await readWorker()).snapshot.sources.length, 1);
  await database.transaction([kernel('repositories').savepoint('scope_rollback', [
    repo('ContextSegmentSource').insert({ id: 'savepoint-source', segment_id: 's', source_kind: 'system', source_id: 'savepoint-owner', source_revision: 0n, created_at: NOW }),
    repo('ContextSegment').insert({ id: 's', content_object_id: content.id, segment_kind: 'system', created_at: NOW })
  ], { kind: 'rollback-and-continue-on-unique', constraints: [{ domain: 'ContextSegment', columns: ['id'] }] })]);
  assert.equal((await database.inspect()).attachmentScopeCache.entries, 0);
  assert.equal((await readWorker()).snapshot.sources.length, 1);
  await database.transaction([
    repo('ContextSegment').insert({ id: 'seg\uFFFD', content_object_id: content.id, segment_kind: 'system', created_at: NOW }),
    repo('ContextSegmentSource').insert({ id: 'unicode-original', segment_id: 'seg\uFFFD', source_kind: 'system', source_id: 'unicode-owner', source_revision: 0n, created_at: NOW })
  ]);
  await database.attachmentProjectionSegments('main', ['seg\uFFFD']);
  await database.transaction([repo('ContextSegmentSource').insert({ id: 'unicode-later', segment_id: 'seg\uD800', source_kind: 'system', source_id: 'unicode-later-owner', source_revision: 0n, created_at: NOW })]);
  assert.equal((await database.attachmentProjectionSegments('main', ['seg\uFFFD'])).snapshot.sources.length, 2);
  await database.close(); database = undefined;
  await kernel('runtimeHostControl').withRuntimeMaintenance(candidate.authority.expectedPaths(), async () => {
    database = await api.RuntimeDatabase.open(candidate.authority, { hostBootId: 'historical-merge-scope', maintenance: true });
    await readWorker(); await database.maintenanceBegin(); await readWorker(); await database.maintenanceRollback(); await readWorker();
    assert.equal((await database.inspect()).attachmentScopeCache.entries, 0);
    await database.close(); database = undefined;
  });
});
