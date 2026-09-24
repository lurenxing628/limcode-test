import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const kernel = require(path.resolve('dist/extension/backend/reliableKernel/index.js'));
const { RUNTIME_DOMAIN_SCHEMAS } = require(path.resolve('dist/extension/backend/reliableKernel/schema/domainManifest.js'));
const { VscodeReliableKernelCutoverCoordinator } = require(path.resolve('dist/extension/backend/application/reliableKernel/VscodeReliableKernelCutoverCoordinator.js'));
const Database = require('better-sqlite3');

test('epoch5 collaboration schema and authority crosswalk have one exact definition', async () => {
  assert.equal(kernel.RUNTIME_KERNEL_EPOCH, 5);
  assert.equal(RUNTIME_DOMAIN_SCHEMAS.length, 107);
  const authority = JSON.parse(await fs.readFile('docs/architecture/reliable-kernel/contracts/authority.json', 'utf8'));
  assert.equal(authority.runtimeDomains.length, 107);
  // Cross-conversation reach is not a per-pair grant table; only team lineage and completion replies route.
  assert.equal(RUNTIME_DOMAIN_SCHEMAS.some(schema => schema.key === 'ConversationCommunicationLink'), false);
  assert.equal(authority.runtimeDomains.some(row => row.key === 'ConversationCommunicationLink'), false);
  for (const schema of RUNTIME_DOMAIN_SCHEMAS) {
    const contract = authority.runtimeDomains.find(row => row.key === schema.key);
    assert.ok(contract, schema.key);
    for (const key of ['table', 'repository', 'codec', 'mutations', 'client', 'deletePolicy', 'resetPolicy', 'indexes']) {
      assert.deepEqual(schema[key], contract[key], `${schema.key}.${key}`);
    }
  }
  assert.equal(typeof kernel.migratePreviousRuntimeEpochIfRequired, 'function');
  assert.equal(kernel.migrateCurrentRuntimeManifestIfRequired, undefined);
});

for (const [label, mutate] of [
  ['missing collaboration table', db => { db.exec('DROP TABLE collaboration_request_turn_link'); db.prepare('DELETE FROM schema_manifest WHERE domain_key = ?').run('CollaborationRequestTurnLink'); }],
  ['missing formerly additive table', db => { db.exec('DROP TABLE runtime_delivery_intent_link'); db.prepare('DELETE FROM schema_manifest WHERE domain_key = ?').run('RuntimeDeliveryIntentLink'); }],
  ['manifest drift', db => db.prepare("UPDATE schema_manifest SET client_mapping = 'detail' WHERE domain_key = 'CollaborationMessage'").run()],
  ['extra physical object', db => db.exec('CREATE TABLE unknown_collaboration (id TEXT PRIMARY KEY)')],
  ['index drift', db => { db.exec('DROP INDEX ux_collaboration_request_01'); db.exec('CREATE INDEX ux_collaboration_request_01 ON collaboration_request (budget_id)'); }]
]) test(`current epoch5 ${label} fails closed without repair or archive`, async () => {
  const scope = await fs.mkdtemp(path.join(os.tmpdir(), 'limcode-collaboration-schema-'));
  try {
    const authority = new kernel.RootAuthority(() => path.join(scope, '.limcode-runtime', 'active'));
    const initial = await new VscodeReliableKernelCutoverCoordinator(authority, scope).ensureCurrentRoot();
    const pointer = await fs.readFile(initial.binding.paths.rootPointerPath);
    const database = new Database(kernel.toSqliteFilePath(initial.binding.paths.databasePath));
    try { database.pragma('foreign_keys = OFF'); mutate(database); database.pragma('wal_checkpoint(TRUNCATE)'); } finally { database.close(); }
    const before = await fs.readFile(initial.binding.paths.databasePath);
    await assert.rejects(new VscodeReliableKernelCutoverCoordinator(authority, scope).ensureCurrentRoot());
    assert.deepEqual(await fs.readFile(initial.binding.paths.rootPointerPath), pointer);
    assert.deepEqual(await fs.readFile(initial.binding.paths.databasePath), before);
    await assert.rejects(fs.access(path.join(scope, '.limcode-runtime-backups')), { code: 'ENOENT' });
  } finally { await fs.rm(scope, { recursive: true, force: true }); }
});
