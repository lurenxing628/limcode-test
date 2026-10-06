import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import test from 'node:test';

const require = createRequire(import.meta.url);
const compiled = path.resolve(process.env.LIMCODE_TEST_EXTENSION_ROOT ?? 'dist/extension');
const load = file => require(path.join(compiled, 'backend/reliableKernel', file));
const kernel = load('index.js');
const Database = require('better-sqlite3');
const { CONTEXT_SEQUENCE_NODE_BATCH_LIMIT } = load('repositories.js');
const { PACKED_CAS_FILE } = load('packedCasWorkerProtocol.js');
const { toSqliteFilePath } = load('sqliteFilePath.js');
const repo = name => kernel.DOMAIN_REPOSITORIES.domain(name);
const NOW = '2026-10-06T00:00:00.000Z';
const MAX_ENTRIES = 4096;
const MAX_BYTES = 32 * 1024 * 1024;
const looseFile = (f, metadata) => path.join(f.binding.paths.casRootPath, ...metadata.storage_key.split('/'));

// Exercise the actual worker, packed/loose readers and transferred buffers. Batch only fixture
// publication and immutable nodes, so the 4096-entry boundary needs no model turns or 4096 commits.
async function fixture(run) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'limcode-context-cas-cache-'));
  const authority = new kernel.RootAuthority(() => path.join(directory, 'runtime'));
  const binding = await kernel.initializeEmptyRuntimeRoot(authority);
  let database = await kernel.RuntimeDatabase.open(authority);
  let count = 0;
  const records = [];
  const f = {
    authority, binding, records,
    get database() { return database; },
    inspect: async () => (await database.inspect()).contextCasCache,
    materialize: rootId => database.materializeContextContent(rootId),
    async reopen() { await database.close(); database = await kernel.RuntimeDatabase.open(authority); },
    async append(contents) {
      const store = kernel.ContentAddressedStore.forDatabase(authority, database);
      const prepared = await store.prepareBatch(database, contents.map(content => ({ content, contentType: 'application/octet-stream' })));
      const inserts = [...new Map(prepared.filter(entry => entry.insert).map(entry => [entry.metadata.id, entry.insert])).values()];
      const nodes = [];
      for (let index = 0; index < contents.length; index += 1) {
        const ordinal = count + index;
        const segmentId = `segment-${ordinal}`;
        inserts.push(repo('ContextSegment').insert({ id: segmentId, content_object_id: prepared[index].metadata.id,
          segment_kind: 'system', created_at: NOW }));
        nodes.push({ id: `node-${ordinal}`, parent_node_id: ordinal ? `node-${ordinal - 1}` : null,
          segment_id: segmentId, created_at: NOW });
        records.push({ nodeId: `node-${ordinal}`, metadata: prepared[index].metadata, bytes: Buffer.from(contents[index]) });
      }
      for (let offset = 0; offset < nodes.length; offset += CONTEXT_SEQUENCE_NODE_BATCH_LIMIT) {
        inserts.push(repo('ContextSequenceNode').ensureContextSequenceNodes(nodes.slice(offset, offset + CONTEXT_SEQUENCE_NODE_BATCH_LIMIT)));
      }
      count += contents.length;
      const rootId = `root-${count}`;
      inserts.push(repo('ContextSequenceRoot').insertWithNextSequence({ id: rootId, conversation_id: 'conversation',
        root_node_id: `node-${count - 1}`, tail_node_id: null, tail_segment_count: 0n,
        segment_count: BigInt(count), estimated_tokens: BigInt(count), created_at: NOW },
      { column: 'root_seq', scope: { conversation_id: 'conversation' } }));
      await database.transaction(inserts);
      return rootId;
    }
  };
  try {
    await database.transaction([repo('Conversation').insert({ id: 'conversation', title: 'cache regression', status: 'active',
      created_at: NOW, updated_at: NOW })]);
    await run(f);
  } finally { await database.close(); await fs.rm(directory, { recursive: true, force: true }); }
}

function assertBounds(cache) {
  assert.equal(cache.maxEntries, MAX_ENTRIES);
  assert.equal(cache.maxBytes, MAX_BYTES);
  assert.ok(cache.entries <= MAX_ENTRIES);
  assert.ok(cache.bytes <= MAX_BYTES);
}

async function scan(f, rootId, expectedMisses, expectedRecords = f.records) {
  const before = await f.inspect();
  const result = await f.materialize(rootId);
  const after = await f.inspect();
  assertBounds(after);
  const records = result.snapshot.records;
  assert.equal(records.length, expectedRecords.length);
  const uniqueCount = new Set(expectedRecords.map(record => record.metadata.id)).size;
  if (expectedMisses !== undefined) {
    assert.equal(after.misses - before.misses, expectedMisses, 'one backend read per unique object absent at scan start');
    assert.equal(after.hits - before.hits, uniqueCount - expectedMisses);
  }
  assert.equal(after.hits - before.hits + after.misses - before.misses, uniqueCount);
  for (let index = 0; index < records.length; index += 1) {
    assert.equal(records[index].node.id, expectedRecords[index].nodeId, 'chronological record order');
    assert.equal(records[index].contentObject.id, expectedRecords[index].metadata.id);
    assert.deepEqual(Buffer.from(records[index].content), expectedRecords[index].bytes);
  }
  return { result, before, after };
}

const smallBodies = (start, count) => Array.from({ length: count }, (_, index) => Buffer.from(`context-cache-${start + index}`));

test('worker Context materialization retains scan hits across 4092/4104/4116 unique objects', async () => fixture(async f => {
  let root = await f.append(smallBodies(0, 4092));
  await scan(f, root, 4092);
  await scan(f, root, 0);
  root = await f.append(smallBodies(4092, 12));
  await scan(f, root, 12);
  for (let pass = 0; pass < 3; pass += 1) {
    const { after } = await scan(f, root, 8);
    assert.equal(after.entries, MAX_ENTRIES);
  }
  root = await f.append(smallBodies(4104, 12));
  for (let pass = 0; pass < 3; pass += 1) await scan(f, root, 20);
  // An older immutable root is still materialized exactly, without adopting the newest head.
  await scan(f, 'root-4092', undefined, f.records.slice(0, 4092));
}));

test('worker Context scan is resistant to the byte budget with only two large objects', async () => fixture(async f => {
  // Just one byte over the actual 32 MiB budget, and only two loose CAS files.
  const root = await f.append([Buffer.alloc(MAX_BYTES / 2, 0x31), Buffer.alloc(MAX_BYTES / 2 + 1, 0x32)]);
  await scan(f, root, 2);
  for (let pass = 0; pass < 3; pass += 1) {
    const { after } = await scan(f, root, 1);
    assert.equal(after.entries, 1);
    assert.ok(after.bytes === MAX_BYTES / 2 || after.bytes === MAX_BYTES / 2 + 1);
  }
}));

test('worker cached content preserves empty bodies, duplicate identity, order and buffer isolation', async () => fixture(async f => {
  const root = await f.append([Buffer.from('one'), Buffer.alloc(0), Buffer.from('one'), Buffer.from('two')]);
  const { result, after } = await scan(f, root, 3);
  assert.equal(after.entries, 3);
  for (const record of result.snapshot.records) record.content.fill(0xff);
  await scan(f, root, 0);
  await f.reopen();
  assert.equal((await f.inspect()).entries, 0, 'a new worker cannot inherit verified bytes');
  await scan(f, root, 3);
}));

test('worker rejects altered cached identities and retains RootBinding/closed-owner fences', async () => fixture(async f => {
  const root = await f.append([Buffer.from('identity-proof')]);
  await scan(f, root, 1);
  const metadata = f.records[0].metadata;
  const connection = new Database(toSqliteFilePath(f.binding.paths.databasePath));
  const update = connection.prepare('UPDATE content_object SET sha256 = ?, byte_length = ?, storage_key = ? WHERE id = ?');
  try {
    for (const changed of [
      { sha256: 'b'.repeat(64), byte_length: metadata.byte_length, storage_key: `sha256/bb/${'b'.repeat(64)}` },
      { ...metadata, byte_length: metadata.byte_length + 1n },
      { ...metadata, storage_key: `sha256/bb/${'b'.repeat(64)}` }
    ]) {
      update.run(changed.sha256, changed.byte_length, changed.storage_key, metadata.id);
      await assert.rejects(f.materialize(root), /metadata changed|storage key does not match/);
      update.run(metadata.sha256, metadata.byte_length, metadata.storage_key, metadata.id);
      await scan(f, root, 0);
    }
  } finally { update.run(metadata.sha256, metadata.byte_length, metadata.storage_key, metadata.id); connection.close(); }
  const validate = f.authority.validate;
  f.authority.validate = async () => { throw new Error('RootBinding fence fixture'); };
  try { await assert.rejects(f.materialize(root), /RootBinding fence fixture/); }
  finally { f.authority.validate = validate; }
  await scan(f, root, 0);
  await f.database.close();
  await assert.rejects(f.materialize(root), /closed/);
}));

test('worker rejects uncached packed corruption even with valid loose bytes and never caches failure', async () => fixture(async f => {
  const first = await f.append([Buffer.from('resident-good')]);
  await scan(f, first, 1);
  const root = await f.append([Buffer.from('packed-unverified')]);
  const record = f.records[1];
  await kernel.ContentAddressedStore.loose(f.authority, f.binding).publish(record.bytes, 'application/octet-stream');
  const connection = new Database(toSqliteFilePath(path.join(f.binding.paths.casRootPath, PACKED_CAS_FILE)));
  const update = connection.prepare('UPDATE cas_body SET body = ? WHERE digest = ?');
  const digest = Buffer.from(record.metadata.sha256, 'hex');
  try {
    update.run(Buffer.alloc(record.bytes.length, 0x78), digest);
    const before = await f.inspect();
    await assert.rejects(f.materialize(root), /digest mismatch/);
    const after = await f.inspect();
    assert.equal(after.entries, before.entries);
    assert.equal(after.bytes, before.bytes);
    assert.equal(after.misses - before.misses, 1);
    update.run(record.bytes, digest);
    await scan(f, root, 1);
    await f.database.close();
    update.run(Buffer.alloc(record.bytes.length, 0x79), digest);
    await f.reopen();
    await assert.rejects(f.materialize(root), /digest mismatch/, 'reopening never reuses an old cached proof');
  } finally { update.run(record.bytes, digest); connection.close(); }
}));

test('worker rejects missing, truncated and corrupt uncached loose bodies, then retries verified bytes', async () => fixture(async f => {
  const root = await f.append([Buffer.alloc(8193, 0x41)]);
  const record = f.records[0];
  const filename = looseFile(f, record.metadata);
  for (const [damage, message] of [
    [() => fs.unlink(filename), /ENOENT/],
    [() => fs.writeFile(filename, record.bytes.subarray(1)), /byte length mismatch/],
    [() => fs.writeFile(filename, Buffer.alloc(record.bytes.length, 0x42)), /digest mismatch/]
  ]) {
    await damage();
    await assert.rejects(f.materialize(root), message);
    const cache = await f.inspect();
    assert.equal(cache.entries, 0);
    assert.equal(cache.bytes, 0);
    await fs.writeFile(filename, record.bytes);
  }
  await scan(f, root, 1);
  await scan(f, root, 0);
}));
