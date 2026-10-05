import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import {
  Database, createConfigurationRoot, removeConfigurationRoot, withRuntime, repo, NOW, kernel, kernelFile, modelRequestAggregate
} from './fixtures/runtime-merge-fixture.mjs';

const { mergeHistoricalDataSetsOnline, planMergeChunk } = kernelFile('runtimeDataSetMerge.js');
const { prepareLargeMergeSources, releaseLargeMergePreparation } = kernelFile('runtimeDataSetStreamedMerge.js');
const { readRuntimeDataSetMergeLedger } = kernelFile('runtimeDataSetMergeLedger.js');
const { RUNTIME_DOMAIN_SCHEMAS } = kernelFile('schema/domainManifest.js');
const conversation = (id) => ({ id, title: id, status: 'active', created_at: NOW, updated_at: NOW });

async function fixture(t, { newRow = false } = {}) {
  const f = await createConfigurationRoot();
  const connections = [];
  let database;
  t.after(async () => {
    await database?.close();
    for (const connection of connections) connection.close();
    await removeConfigurationRoot(f.root);
  });
  await withRuntime(f.alpha, (database) => database.transaction([
    repo('Conversation').insert(conversation('shared')),
    ...(newRow ? [repo('Conversation').insert(conversation('new'))] : [])
  ]));
  database = await kernel.RuntimeDatabase.open(f.current.authority, { hostBootId: 'merge-commit-guards' });
  return { ...f, database, connections };
}
const merge = (f, options = {}) => mergeHistoricalDataSetsOnline(f.paths,
  { configurationRootPath: f.root, database: f.database },
  { candidateIds: [f.alpha.id], requested: true, ...options });
const ledger = async (f) => (await readRuntimeDataSetMergeLedger(f.paths)).get(f.alpha.id);

function assertDeferred(report) {
  assert.equal(report.deferred.length, 1);
  assert.deepEqual([report.merged, report.blocked, report.failures], [[], [], []]);
}

test('an empty historical source checkpoints and publishes its ledger without an empty transaction', async t => {
  const f = await createConfigurationRoot();
  f.database = await kernel.RuntimeDatabase.open(f.current.authority, { hostBootId: 'empty-source-merge' });
  t.after(async () => { await f.database.close(); await removeConfigurationRoot(f.root); });
  const transaction = f.database.transaction.bind(f.database);
  f.database.transaction = async (steps, ...rest) => {
    assert.ok(steps.length > 0, 'empty assertion sets are not transactions');
    return transaction(steps, ...rest);
  };
  let checkpoints = 0;
  const checkpoint = f.database.durabilityCheckpoint.bind(f.database);
  f.database.durabilityCheckpoint = async () => {
    checkpoints++;
    assert.equal(await ledger(f), undefined, 'durability precedes the success ledger');
    await checkpoint();
  };
  const result = await merge(f);
  assert.deepEqual([result.deferred, result.blocked, result.failures], [[], [], []]);
  assert.equal(result.merged.length, 1);
  assert.equal(result.merged[0].insertedRows, 0);
  assert.equal(result.merged[0].reusedRows, 0);
  assert.equal(checkpoints, 1);
  assert.equal((await ledger(f)).state, 'merged');
});

test('all-reused merge validates rows and checkpoints NORMAL writes before publishing its ledger', async (t) => {
  const f = await fixture(t);
  await f.database.transaction([repo('Conversation').insert(conversation('shared'))]);
  const events = [];
  const transaction = f.database.transaction.bind(f.database);
  f.database.transaction = async (steps, ...rest) => {
    events.push('validate');
    assert.ok(steps.length > 0 && steps.every((step) => step.kind === 'assert'));
    assert.equal(steps.find((step) => step.domain === 'Conversation').where.title, 'shared');
    return transaction(steps, ...rest);
  };
  const checkpoint = f.database.durabilityCheckpoint.bind(f.database);
  f.database.durabilityCheckpoint = async () => {
    events.push('checkpoint');
    assert.equal(await ledger(f), undefined, 'no external success before durability');
    await checkpoint();
    // Inspect a main-file-only copy before Runtime close can checkpoint it incidentally.
    const copy = path.join(f.root, 'checkpoint-proof.sqlite');
    await fs.copyFile(f.database.binding.paths.databasePath, copy);
    const disk = new Database(copy, { readonly: true });
    try { assert.equal(disk.prepare('SELECT title FROM conversation WHERE id = ?').get('shared').title, 'shared'); }
    finally { disk.close(); }
  };
  const report = await merge(f);
  assert.deepEqual(events, ['validate', 'checkpoint']);
  assert.equal(report.merged.length, 1);
  assert.equal(report.merged[0].alreadyMerged, true);
  assert.equal(report.merged[0].backupPath, undefined);
  assert.equal((await ledger(f)).state, 'merged');
});

test('all-reused merge with a pinned WAL reader cannot publish success until the checkpoint succeeds', async (t) => {
  const f = await fixture(t);
  const reader = new Database(f.database.binding.paths.databasePath, { readonly: true });
  f.connections.push(reader);
  reader.exec('BEGIN');
  reader.prepare('SELECT count(*) FROM conversation').get();
  await f.database.transaction([repo('Conversation').insert(conversation('shared'))]);
  const report = await merge(f);
  assertDeferred(report);
  assert.equal(await ledger(f), undefined);
  reader.exec('ROLLBACK');
  const retried = await merge(f);
  assert.equal(retried.merged.length, 1);
  assert.equal((await ledger(f)).state, 'merged');
});

for (const newRow of [false, true]) {
  for (const external of [false, true]) {
    test(`${newRow ? 'mixed' : 'all-reused'} merge rejects a ${external ? 'second-connection' : 'local'} edit after comparison without permanently blocking the source`, async (t) => {
      const f = await fixture(t, { newRow });
      await f.database.transaction([repo('Conversation').insert(conversation('shared'))]);
      const transaction = f.database.transaction.bind(f.database);

      const snapshot = f.database.snapshot.bind(f.database);
      let changed = false;
      f.database.snapshot = async (...args) => {
        const result = await snapshot(...args);
        if (!changed && result.snapshot.some((row) => row && !Array.isArray(row) && row.id === 'shared')) {
          changed = true;
          if (external) execFileSync(process.execPath, ['-e', `
            const Database = require('better-sqlite3');
            const writer = new Database(process.argv[1]);
            try { writer.prepare('UPDATE conversation SET title = ? WHERE id = ?').run('concurrent edit', 'shared'); }
            finally { writer.close(); }
          `, f.database.binding.paths.databasePath]);
          else await transaction([repo('Conversation').update('shared', { title: 'concurrent edit' })]);
        }
        return result;
      };
      const report = await merge(f);
      assert.equal(changed, true);
      assertDeferred(report);
      assert.equal(report.deferred[0].code, 'RUNTIME_TRANSACTION_ASSERTION_FAILED');
      assert.equal(await ledger(f), undefined, 'no success or permanent refusal survives the rolled-back attempt');
      const rows = (await snapshot([repo('Conversation').list({ limit: 10 })])).snapshot[0];
      assert.deepEqual(rows.map((row) => [row.id, row.title]), [['shared', 'concurrent edit']], 'all new rows rolled back; concurrent edit survives');
      await transaction([repo('Conversation').update('shared', { title: 'shared' })]);
      const retry = await merge(f);
      assert.equal(retry.merged.length, 1);
      assert.equal((await ledger(f)).state, 'merged');
    });
  }
}

test('reuse assertions preserve content-identity exceptions and collaboration renumbering', () => {
  const examples = [
    ['ProjectContext', { id: 'project', kind: 'folder', uri: 'file:///project', name: 'source', created_at: NOW, updated_at: NOW },
      { name: 'target', created_at: '2026-09-29T00:00:00.000Z', updated_at: '2026-09-29T00:00:00.000Z' }, ['name', 'created_at', 'updated_at']],
    ['CollaborationMessage', { id: 'message', dedupe_key: 'message', mode: 'message', message_seq: 1n, created_at: NOW },
      { message_seq: 42n }, ['message_seq']]
  ];
  for (const [domain, row, differences, ignored] of examples) {
    const sink = { steps: [], presence: [], inserted() { assert.fail('must reuse'); },
      reused() {}, conflict() { assert.fail('allowed difference must not conflict'); }, savepointName: () => 'unused' };
    const schema = RUNTIME_DOMAIN_SCHEMAS.find((item) => item.key === domain);
    planMergeChunk(schema, [row], [{ ...row, ...differences }], sink);
    assert.equal(sink.presence.length, 1);
    const expected = Object.fromEntries(schema.columns.filter(({ name }) => name !== 'id' && !ignored.includes(name))
      .map(({ name }) => [name, row[name]]));
    assert.deepEqual(sink.presence[0].where, expected);
    assert.ok(Object.keys(expected).length > 0);
  }
});

for (const usage of [null, 'usage unavailable', '{"looks":"structured"}']) {
  test(`reused model JSON preserves formatting equivalence and scalar ${JSON.stringify(usage)}`, async (t) => {
    const f = await fixture(t);
    const seed = async (database, store, target = false) => {
      const recipe = await store.ingest(database, '{}', 'application/json');
      const steps = [
        repo('Turn').insert({ id: 'shared-turn', conversation_id: 'shared', status: 'terminated', created_at: NOW, updated_at: NOW, terminal_at: NOW }),
        repo('TurnTermination').insert({ id: 'shared-termination', turn_id: 'shared-turn', terminal_status: 'completed', reason: 'fixture', created_at: NOW }),
        ...modelRequestAggregate('shared-turn', 'shared-model', 1n, { recipe: recipe.id, body: recipe.id, checkpoints: 1 })
      ];
      steps.find((step) => step.domain === 'ModelRequest').row.usage_json = usage === null ? null : JSON.stringify(usage);
      if (target) steps.find((step) => step.domain === 'ModelRequest').row.stream_stats_json =
        { retryReason: null, socketGeneration: '0', attemptSeq: '1' };
      await database.transaction(steps);
    };
    await withRuntime(f.alpha, (database, store) => seed(database, store));
    await f.database.transaction([repo('Conversation').insert(conversation('shared'))]);
    await seed(f.database, kernel.ContentAddressedStore.forDatabase(f.current.authority, f.database), true);
    // A valid stored JSON representation need not have the writer's usual whitespace. Use another
    // process so closing this fixture connection cannot release the live Runtime's POSIX locks.
    execFileSync(process.execPath, ['-e', `
      const Database = require('better-sqlite3');
      const writer = new Database(process.argv[1]);
      try { writer.prepare('UPDATE model_request SET stream_stats_json = ? WHERE id = ?')
        .run(' { "retryReason": null, "socketGeneration": "0", "attemptSeq": "1" } ', 'shared-model'); }
      finally { writer.close(); }
    `, f.database.binding.paths.databasePath]);
    const report = await merge(f);
    assert.deepEqual([report.deferred, report.blocked, report.failures], [[], [], []]);
    assert.equal(report.merged.length, 1);
    assert.equal(report.merged[0].insertedRows, 0);
    await assert.rejects(f.database.transaction([repo('ModelRequest').assert('shared-model', {
      stream_stats_json: { attemptSeq: '2', socketGeneration: '0', retryReason: null }
    }, { decoded: true })]), { code: 'RUNTIME_TRANSACTION_ASSERTION_FAILED' }, 'semantic changes still fail');
    await assert.rejects(f.database.transaction([repo('ModelRequest').assert('shared-model', {
      stream_stats_json: { attemptSeq: '1', socketGeneration: '0', retryReason: null }
    })]), { code: 'RUNTIME_TRANSACTION_ASSERTION_FAILED' }, 'default textual assertion semantics stay unchanged');
  });
}

for (const race of [undefined, 'scan', 'checkpoint']) {
  test(`streamed all-reused preparation ${race ? `defers an edit during ${race}` : 'checkpoints before success'} without retaining all rows`, async (t) => {
    const f = await fixture(t);
    await f.database.transaction([repo('Conversation').insert(conversation('shared'))]);
    const transaction = f.database.transaction.bind(f.database);
    const snapshot = f.database.snapshot.bind(f.database);
    let changed = false;
    f.database.snapshot = async (...args) => {
      const result = await snapshot(...args);
      if (race === 'scan' && !changed && result.snapshot.some((row) => row && !Array.isArray(row) && row.id === 'shared')) {
        changed = true;
        await transaction([repo('Conversation').update('shared', { title: 'concurrent edit' })]);
      }
      return result;
    };
    let checkpoints = 0;
    const checkpoint = f.database.durabilityCheckpoint.bind(f.database);
    f.database.durabilityCheckpoint = async () => {
      checkpoints += 1;
      assert.equal(await ledger(f), undefined);
      await checkpoint();
      if (race === 'checkpoint') {
        changed = true;
        await transaction([repo('Conversation').update('shared', { title: 'concurrent edit' })]);
      }
    };
    const preparation = await prepareLargeMergeSources({ paths: f.paths,
      target: { configurationRootPath: f.root, database: f.database }, candidateIds: [f.alpha.id], requested: true,
      options: { sizeLimits: { transactionRows: 0 }, chunkRows: 1 } });
    try {
      if (race) {
        assert.equal(changed, true);
        assertDeferred(preparation.report);
        assert.equal(preparation.report.deferred[0].code, 'runtime-data-set-merge-target-changed');
        assert.equal(await ledger(f), undefined);
      } else {
        assert.equal(checkpoints, 1);
        assert.equal(preparation.report.merged.length, 1);
        assert.equal((await ledger(f)).state, 'merged');
      }
    } finally { await releaseLargeMergePreparation(preparation); }
  });
}
