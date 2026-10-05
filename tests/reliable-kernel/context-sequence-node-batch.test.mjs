import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import test from 'node:test';

const require = createRequire(import.meta.url);
const compiled = path.resolve(process.env.LIMCODE_TEST_EXTENSION_ROOT ?? 'dist/extension');
const load = name => require(path.join(compiled, 'backend/reliableKernel', name));
const Database = require('better-sqlite3');
const { DOMAIN_REPOSITORIES, CONTEXT_SEQUENCE_NODE_BATCH_LIMIT: LIMIT, savepoint } = load('repositories.js');
const { createRuntimeDomainTableSql, createRuntimeDomainIndexSql } = load('schema/domainManifest.js');
const { executeContextSequenceNodeBatch } = load('contextSequenceNodeBatch.js');
const { attachRuntimeStatementCache, detachRuntimeStatementCache, prepareCached } = load('runtimeStatementCache.js');
const { requireEncodedId } = load('runtimeSqlRows.js');
const repo = DOMAIN_REPOSITORIES.domain('ContextSequenceNode');
const NOW = '2026-10-03T00:00:00.000Z';
const LATER = '2026-10-03T01:00:00.000Z';
const CONSTRAINTS = [
  { domain: 'ContextSequenceNode', columns: ['id'] },
  { domain: 'ContextSequenceNode', columns: ['parent_node_id', 'segment_id'] },
  { domain: 'ContextSequenceNode', columns: ['segment_id'] }
];

// Frozen pre-change planning shape, retained solely as the differential test oracle.
const legacy = rows => rows.flatMap((row, index) => [
  savepoint(`legacy_node_${index}`, [repo.insert(row)], {
    kind: 'rollback-and-continue-on-unique', constraints: CONSTRAINTS
  }),
  repo.assert(row.id, { parent_node_id: row.parent_node_id, segment_id: row.segment_id })
]);
const compact = rows => {
  const steps = [];
  for (let offset = 0; offset < rows.length; offset += LIMIT) steps.push(repo.ensureContextSequenceNodes(rows.slice(offset, offset + LIMIT)));
  return steps;
};
const identity = (kind, value) => `${kind}_${createHash('sha256').update(String(value)).digest('hex')}`;
const node = (id, parent = null, segment = `${id}-segment`, created = NOW) =>
  ({ id, parent_node_id: parent, segment_id: segment, created_at: created });
function chain(count) {
  let parent = null;
  return Array.from({ length: count }, (_, index) => {
    const row = node(identity('context_node', index), parent, identity('context_segment', index));
    parent = row.id;
    return row;
  });
}

function oracleUnique(error, policy) {
  if (policy === 'propagate' || !['SQLITE_CONSTRAINT_UNIQUE', 'SQLITE_CONSTRAINT_PRIMARYKEY'].includes(error.code)) return false;
  const marker = 'UNIQUE constraint failed:';
  const at = error.message.indexOf(marker);
  if (at < 0) return false;
  const actual = error.message.slice(at + marker.length).split(',').map(value => value.trim()).filter(Boolean).sort();
  return policy.constraints.some(constraint => {
    const table = DOMAIN_REPOSITORIES.domain(constraint.domain).schema.table;
    const expected = constraint.columns.map(column => `${table}.${column}`).sort();
    return expected.length === actual.length && expected.every((column, index) => column === actual[index]);
  });
}

// Minimal old executeSteps behavior for real SQLite differential tests. Worker integration below
// independently executes both plan forms through the production RuntimeDatabase.
function execute(database, steps) {
  for (const step of steps) {
    if (step.kind === 'ensureContextSequenceNodes') { executeContextSequenceNodeBatch(database, step); continue; }
    if (step.kind === 'savepoint') {
      database.exec(`SAVEPOINT "${step.name}"`);
      try { execute(database, step.steps); database.exec(`RELEASE SAVEPOINT "${step.name}"`); }
      catch (error) {
        database.exec(`ROLLBACK TO SAVEPOINT "${step.name}"`);
        database.exec(`RELEASE SAVEPOINT "${step.name}"`);
        if (!oracleUnique(error, step.onError)) throw error;
      }
      continue;
    }
    if (step.kind === 'insert') {
      const encoded = repo.codec.encodeInsert(step.row);
      requireEncodedId(encoded.id, repo.codec.name);
      prepareCached(database, 'INSERT INTO context_sequence_node (id,parent_node_id,segment_id,created_at) VALUES (@id,@parent_node_id,@segment_id,@created_at)').run(encoded);
      continue;
    }
    assert.equal(step.kind, 'assert');
    const encoded = repo.codec.encodeWhere(step.where);
    if (!prepareCached(database, 'SELECT 1 FROM context_sequence_node WHERE id = ? AND parent_node_id IS ? AND segment_id = ? LIMIT 1')
      .get(step.id, encoded.parent_node_id, encoded.segment_id)) {
      throw Object.assign(new Error(`ContextSequenceNodeRepository transaction assertion failed for ${step.id}.`),
        { code: 'RUNTIME_TRANSACTION_ASSERTION_FAILED' });
    }
  }
}

function openFixture(seed, segments) {
  const database = new Database(':memory:');
  database.pragma('foreign_keys = ON');
  database.defaultSafeIntegers(true);
  database.exec('CREATE TABLE context_segment (id TEXT PRIMARY KEY)');
  database.exec(createRuntimeDomainTableSql(repo.schema));
  for (const [ordinal, definition] of repo.schema.indexes.entries()) database.exec(createRuntimeDomainIndexSql(repo.schema, definition, ordinal));
  database.exec(`CREATE TEMP TABLE node_changes (position INTEGER PRIMARY KEY, id TEXT NOT NULL);
    CREATE TEMP TRIGGER capture_test_node AFTER INSERT ON context_sequence_node BEGIN
      INSERT INTO node_changes(id) VALUES (NEW.id); END;`);
  const segmentInsert = database.prepare('INSERT INTO context_segment(id) VALUES (?)');
  for (const segment of new Set(segments)) segmentInsert.run(segment);
  const insert = database.prepare('INSERT INTO context_sequence_node(id,parent_node_id,segment_id,created_at) VALUES (@id,@parent_node_id,@segment_id,@created_at)');
  for (const row of seed) insert.run(row);
  database.exec('DELETE FROM node_changes');

  const stats = { statements: 0, selects: 0, inserts: 0, savepoints: 0, uniqueExceptions: 0 };
  const originalPrepare = database.prepare.bind(database);
  const originalExec = database.exec.bind(database);
  Object.defineProperty(database, 'prepare', { value(sql) {
    const statement = originalPrepare(sql);
    const proxy = new Proxy(statement, { get(target, key) {
      const value = Reflect.get(target, key, target);
      if (typeof value !== 'function') return value;
      return (...args) => {
        const counted = ['run', 'get', 'all', 'iterate'].includes(key) && /context_sequence_node/i.test(sql);
        if (counted) { stats.statements += 1; if (/^\s*SELECT/i.test(sql)) stats.selects += 1; else if (/^\s*INSERT/i.test(sql)) stats.inserts += 1; }
        try { const result = Reflect.apply(value, target, args); return result === target ? proxy : result; }
        catch (error) { if (counted && ['SQLITE_CONSTRAINT_UNIQUE', 'SQLITE_CONSTRAINT_PRIMARYKEY'].includes(error.code)) stats.uniqueExceptions += 1; throw error; }
      };
    } });
    return proxy;
  } });
  Object.defineProperty(database, 'exec', { value(sql) {
    if (/^(?:SAVEPOINT|RELEASE SAVEPOINT|ROLLBACK TO SAVEPOINT)/i.test(sql)) { stats.statements += 1; stats.savepoints += 1; }
    return originalExec(sql);
  } });
  attachRuntimeStatementCache(database);
  return { database, stats, read: originalPrepare };
}

function runPlan(steps, { seed = [], segments = [], wrap } = {}) {
  const fixture = openFixture(seed, segments);
  const { database, stats, read } = fixture;
  let error;
  database.exec('BEGIN IMMEDIATE');
  try { execute(database, wrap ? wrap(steps) : steps); database.exec('COMMIT'); }
  catch (caught) { error = { name: caught.name, code: caught.code, message: caught.message }; database.exec('ROLLBACK'); }
  const result = { rows: read('SELECT * FROM context_sequence_node ORDER BY id').all(),
    changes: read('SELECT id FROM node_changes ORDER BY position').all().map(row => row.id), error,
    stats: { ...stats } };
  detachRuntimeStatementCache(database);
  database.close();
  return result;
}
function parity(rows, options = {}) {
  const old = runPlan(legacy(rows), options);
  const current = runPlan(compact(rows), options);
  assert.deepEqual({ ...current, stats: null }, { ...old, stats: null });
  return { old, current };
}

test('fixed node batches are bounded, domain-specific, codec-validated and cloned across savepoints', () => {
  assert.equal(LIMIT, 128);
  assert.throws(() => repo.ensureContextSequenceNodes([]), RangeError);
  assert.throws(() => repo.ensureContextSequenceNodes(Array.from({ length: LIMIT + 1 }, () => node('n'))), RangeError);
  assert.throws(() => DOMAIN_REPOSITORIES.domain('Conversation').ensureContextSequenceNodes([node('n')]), TypeError);
  assert.throws(() => repo.ensureContextSequenceNodes([{ ...node('n'), arbitrary: 'sql' }]), TypeError);
  assert.throws(() => repo.ensureContextSequenceNodes([{ ...node('n'), created_at: null }]), TypeError);
  const step = repo.ensureContextSequenceNodes([node('n')]);
  const nested = savepoint('outer', [step]);
  step.nodes[0][0] = 'changed'; step.nodes.push(['extra', null, 'extra-segment', NOW]);
  assert.deepEqual(nested.steps[0].nodes, [['n', null, 'n-segment', NOW]]);
});

test('fresh child-context planning emits compact batches without recreating per-node wrappers', () => {
  const { ContextSequenceControlPlane } = load('contextSequence.js');
  const context = new ContextSequenceControlPlane({}, {}, { now: () => NOW });
  const plan = context.prepareFreshConversationMessageMutation({ conversationId: 'child', messageRevisionId: 'input',
    contentObjectId: 'body', contentByteLength: 1n, contentEstimatedTokens: 1,
    handleState: load('conversationContextHandleState.js').emptyConversationContextHandleStateStep('child', NOW).row,
    inheritedSegments: Array.from({ length: LIMIT * 2 }, (_, index) => ({ segmentId: `segment-${index}`, estimatedTokens: 1 })) });
  const batches = plan.steps.filter(step => step.kind === 'ensureContextSequenceNodes');
  assert.equal(batches.length, 3);
  assert.equal(batches.reduce((sum, step) => sum + step.nodes.length, 0), LIMIT * 2 + 1);
  assert.ok(batches.every(step => step.nodes.length <= LIMIT));
  assert.equal(plan.steps.filter(step => step.kind === 'savepoint').length, 1, 'only the distinct message-occurrence savepoint remains');
  assert.ok(!plan.steps.some(step => step.kind === 'assert' && step.domain === 'ContextSequenceNode'));
});

test('bounded shared-prefix, new and mixed plans preserve rows/change order while reducing actual SQL', t => {
  const rows = chain(LIMIT * 2 + 1);
  const batches = Math.ceil(rows.length / LIMIT);
  for (const [label, reused] of [['shared-prefix', LIMIT * 2], ['new', 0], ['mixed', LIMIT]]) {
    const desired = rows.map(row => ({ ...row, created_at: LATER }));
    const oldSteps = legacy(desired), currentSteps = compact(desired);
    const { old, current } = parity(desired, { seed: rows.slice(0, reused), segments: rows.map(row => row.segment_id) });
    assert.equal(oldSteps.length, rows.length * 2);
    assert.equal(currentSteps.length, batches);
    assert.equal(old.stats.statements, reused * 5 + (rows.length - reused) * 4);
    assert.equal(current.stats.statements, batches + rows.length - reused);
    assert.equal(old.stats.uniqueExceptions, reused);
    assert.equal(current.stats.uniqueExceptions, 0);
    assert.equal(current.changes.length, rows.length - reused);
    const oldBytes = Buffer.byteLength(JSON.stringify(oldSteps)), currentBytes = Buffer.byteLength(JSON.stringify(currentSteps));
    assert.ok(currentBytes < oldBytes * 0.4);
    t.diagnostic(JSON.stringify({ label, nodes: rows.length, oldTopLevelSteps: oldSteps.length,
      oldNestedSteps: rows.length * 3, compactSteps: currentSteps.length, oldBytes, compactBytes: currentBytes,
      oldSql: old.stats, compactSql: current.stats }));
  }
});

test('duplicates retain first created_at and original input order, including across batch boundaries', () => {
  const rows = [node('a'), node('a', null, 'a-segment', LATER), node('b', 'a')];
  const result = parity(rows, { segments: ['a-segment', 'b-segment'] }).current;
  assert.deepEqual(result.changes, ['a', 'b']);
  assert.equal(result.rows.find(row => row.id === 'a').created_at, NOW);
  const across = chain(LIMIT).concat(node(identity('context_node', 0), null, identity('context_segment', 0), LATER));
  parity(across, { segments: across.map(row => row.segment_id) });
});

test('all three identity collisions retain exact assertion error and atomically roll back prior inserts', () => {
  const a = node('a'), parent = node('parent'), existing = node('existing', 'parent', 'shared');
  const cases = [
    { seed: [a], row: node('a', null, 'changed') },
    { seed: [a], row: node('a', 'missing', 'a-segment') },
    { seed: [a], row: node('other', null, 'a-segment') },
    { seed: [parent, existing], row: node('other', 'parent', 'shared') },
    { seed: [], prefix: [a], row: node('a', null, 'changed') }
  ];
  for (const item of cases) {
    const rows = [...(item.prefix ?? []), node('before'), item.row];
    const result = parity(rows, { seed: item.seed, segments: ['a-segment', 'changed', 'parent-segment', 'shared', 'before-segment'] }).current;
    assert.equal(result.error?.code, 'RUNTIME_TRANSACTION_ASSERTION_FAILED');
    assert.equal(result.error?.message, `ContextSequenceNodeRepository transaction assertion failed for ${item.row.id}.`);
    assert.deepEqual(result.changes, []);
    assert.equal(result.rows.some(row => row.id === 'before'), false);
  }
});

test('missing segment/parent and forward references preserve FOREIGN KEY errors and rollback', () => {
  for (const rows of [[node('bad', 'missing')], [node('bad', null, 'missing')], [node('child', 'later'), node('later')]]) {
    const result = parity([node('before'), ...rows], { segments: ['before-segment', 'bad-segment', 'child-segment', 'later-segment'] }).current;
    assert.equal(result.error?.code, 'SQLITE_CONSTRAINT_FOREIGNKEY');
    assert.deepEqual(result.rows, []); assert.deepEqual(result.changes, []);
  }
});

test('nested savepoint rollback forgets newly inserted identities before later reuse', () => {
  const a = node('a');
  const options = { segments: ['a-segment', 'after-segment'], wrap: steps => [
    savepoint('outer', [...steps, repo.insert(a)], { kind: 'rollback-and-continue-on-unique', constraints: CONSTRAINTS }),
    ...compact([{ ...a, created_at: LATER }]), ...compact([node('after', 'a')])
  ] };
  const result = parity([a], options).current;
  assert.deepEqual(result.changes, ['a', 'after']);
  assert.equal(result.rows.find(row => row.id === 'a').created_at, LATER);
});

test('later malformed worker input does not preempt an earlier FK failure', () => {
  const steps = compact([node('first', 'missing'), node('later')]);
  steps[0].nodes[1][3] = null;
  const old = legacy([node('first', 'missing'), node('later')]);
  old[2].steps[0].row.created_at = null;
  const options = { segments: ['first-segment', 'later-segment'] };
  assert.deepEqual(runPlan(steps, options).error, runPlan(old, options).error);
});

test('SQLite text comparison remains the oracle for unusual UTF-8 boundary values', () => {
  const unusual = node('text', null, 'segment-\ud800');
  parity([unusual], { seed: [unusual], segments: [unusual.segment_id] });
});

test('reused first-writer timestamp is not newly decoded or validated', () => {
  const stored = { ...node('a'), created_at: Buffer.from('historical non-text timestamp') };
  const result = parity([node('a', null, 'a-segment', LATER)], { seed: [stored], segments: ['a-segment'] }).current;
  assert.deepEqual(result.rows[0].created_at, stored.created_at);
  assert.deepEqual(result.changes, []);
});

async function withRuntimeFixture(run) {
  const kernel = load('index.js');
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'limcode-node-batch-'));
  let database;
  try {
    const candidate = await kernel.resetCandidateRuntimeRoot(directory);
    database = await kernel.RuntimeDatabase.open(candidate.authority);
    const store = kernel.ContentAddressedStore.forDatabase(candidate.authority, database);
    const prepared = await store.prepare(database, 'node batch fixture', 'text/plain');
    const content = { ...prepared.metadata, created_at: NOW };
    const insert = (domain, row) => DOMAIN_REPOSITORIES.domain(domain).insert(row);
    await database.transaction([
      insert('ContentObject', content),
      insert('Conversation', { id: 'conversation', title: 'conversation', status: 'active', created_at: NOW, updated_at: NOW }),
      ...['a-segment', 'b-segment'].map(id => insert('ContextSegment', { id, content_object_id: content.id, segment_kind: 'system', created_at: NOW }))
    ]);
    return await run({ database, candidate, insert });
  } finally {
    if (database) await database.close();
    await fs.rm(directory, { recursive: true, force: true });
  }
}

async function runtimeResult(plan) {
  return withRuntimeFixture(async ({ database, insert }) => {
    const commits = [];
    const result = await database.transaction([
      ...plan([node('a'), node('a', null, 'a-segment', LATER), node('b', 'a')]),
      DOMAIN_REPOSITORIES.domain('ContextSequenceRoot').insertWithNextSequence({ id: 'root', conversation_id: 'conversation', root_node_id: 'b',
        tail_node_id: null, tail_segment_count: 0n, segment_count: 2n, estimated_tokens: 2n, created_at: NOW },
      { column: 'root_seq', scope: { conversation_id: 'conversation' } }),
      insert('ConversationContextHeadLink', { id: 'head', conversation_id: 'conversation', root_id: 'root', updated_at: NOW })
    ]);
    commits.push(result);
    commits.push(await database.transaction(plan([node('a', null, 'a-segment', LATER), node('b', 'a', 'b-segment', LATER)])));
    const rows = (await database.snapshot(['a', 'b'].map(id => repo.get(id)))).snapshot;
    const materialized = (await database.materializeContext('root')).snapshot;
    return { commits, rows, materialized };
  });
}

test('production worker keeps node reuse, materialization, allocation and ordered change-feed results identical', async () => {
  const previous = await runtimeResult(legacy);
  const current = await runtimeResult(compact);
  assert.deepEqual(current, previous);
  assert.deepEqual(current.commits[1].changes, []);
  assert.deepEqual(current.commits[0].allocatedSequences, [{ domain: 'ContextSequenceRoot', id: 'root', column: 'root_seq', value: '1' }]);
  assert.ok(current.commits[0].changes.every(change => change.domain !== 'ContextSequenceNode'), 'nodes remain client:none');
});

test('production worker rolls back nested compact nodes and publishes only the later successful facts', async () => {
  await withRuntimeFixture(async ({ database }) => {
    const a = node('a');
    const result = await database.transaction([
      savepoint('outer', [...compact([a]), repo.insert(a)], {
        kind: 'rollback-and-continue-on-unique', constraints: CONSTRAINTS
      }),
      ...compact([{ ...a, created_at: LATER }, node('b', 'a')])
    ]);
    assert.deepEqual(result.changes, []);
    const rows = (await database.snapshot(['a', 'b'].map(id => repo.get(id)))).snapshot;
    assert.equal(rows[0].created_at, LATER);
    assert.equal(rows[1].parent_node_id, 'a');
  });
});

test('source assertions, stale execution authority and root validation still fence compact writes', async () => {
  const { runWithExecutionLeaseFence } = load('executionLeaseFence.js');
  await withRuntimeFixture(async ({ database, candidate, insert }) => {
    await assert.rejects(database.transaction([
      DOMAIN_REPOSITORIES.domain('Conversation').assert('conversation', { title: 'stale-source-title' }),
      ...compact([node('a')])
    ]), error => error.code === 'RUNTIME_TRANSACTION_ASSERTION_FAILED');
    const fence = { id: 'lease', conversationId: 'conversation', turnId: 'turn', ownerId: 'owner',
      hostBootId: database.hostBootId, generation: 1n };
    await database.transaction([
      insert('Turn', { id: 'turn', conversation_id: 'conversation', status: 'active', created_at: NOW, updated_at: NOW }),
      insert('ExecutionLease', { id: 'lease', conversation_id: 'conversation', turn_id: 'turn', owner_id: 'owner',
        host_boot_id: database.hostBootId, generation: 2n, acquired_at: NOW, expires_at: LATER })
    ]);
    await database.conversationOwners.run('conversation', async () => {
      await assert.rejects(runWithExecutionLeaseFence(fence, () => database.transaction(compact([node('a')]))),
        error => error.code === 'EXECUTION_HANDOFF');
    });
    assert.equal((await database.snapshot([repo.get('a')])).snapshot[0], null);
    const validate = candidate.authority.validate;
    candidate.authority.validate = async () => { throw new Error('RootBinding fence fixture'); };
    try { await assert.rejects(database.transaction(compact([node('a')])), /RootBinding fence fixture/); }
    finally { candidate.authority.validate = validate; }
    assert.equal((await database.snapshot([repo.get('a')])).snapshot[0], null);
  });
});
