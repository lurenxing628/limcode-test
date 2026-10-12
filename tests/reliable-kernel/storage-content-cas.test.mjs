import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { before, after, test } from 'node:test';
import { kernel, kernelFile, Database, NOW, repo } from './fixtures/runtime-merge-fixture.mjs';

const { PACKED_CAS_FILE } = kernelFile('packedCasWorkerProtocol.js');
let directory, authority, binding, database, store, loose;
before(async () => {
  directory = await fs.mkdtemp(path.join(os.tmpdir(), 'limcode-ci-cas-'));
  authority = new kernel.RootAuthority(() => path.join(directory, 'runtime'));
  binding = await kernel.initializeEmptyRuntimeRoot(authority);
  database = await kernel.RuntimeDatabase.open(authority);
  store = kernel.ContentAddressedStore.forDatabase(authority, database);
  loose = kernel.ContentAddressedStore.loose(authority, binding);
});
after(async () => {
  await database?.close();
  await fs.rm(directory, { recursive: true, force: true });
});

async function publishLoose(bytes) {
  const value = await loose.publish(bytes, 'application/octet-stream');
  return { id: value.sha256, content_type: value.contentType, sha256: value.sha256,
    byte_length: value.byteLength, storage_key: value.storageKey, created_at: NOW, file: value.absolutePath };
}
async function reopen() {
  await database.close();
  database = await kernel.RuntimeDatabase.open(authority);
  store = kernel.ContentAddressedStore.forDatabase(authority, database);
}
const packedFile = () => path.join(binding.paths.casRootPath, PACKED_CAS_FILE);

test('并发与连续CAS分页返回原字节，只验证一次并释放全部句柄', async () => {
  const bytes = Buffer.from(Array.from({ length: 8193 }, (_, index) => index % 251));
  const item = await publishLoose(bytes);
  const offsets = [0, 1025, 2051];
  const pages = await Promise.all(offsets.map(offset => loose.readChunk(item, offset, 1024)));
  for (const [index, page] of pages.entries()) {
    assert.deepEqual(page.chunk, bytes.subarray(offsets[index], offsets[index] + 1024));
  }
  assert.deepEqual((await loose.readChunk(item, 8192, 10)).chunk, bytes.subarray(8192));
  assert.equal(loose.inspectRangeReadCache().verifications, 1);
  assert.equal(loose.inspectRangeReadCache().activeHandles, 0);
  assert.equal(loose.inspectRangeReadCache().inflight, 0);
  assert.equal(loose.inspectReadCache().bytes, 0);
});

test('CAS校验中规范化目标被替换时拒绝读取，并保留本地符号链接读取语义', async t => {
  const item = await publishLoose(Buffer.alloc(8193, 0x32));
  const canonical = await fs.realpath(item.file);
  const open = fs.open;
  let changed = false;
  t.mock.method(fs, 'open', async (...args) => {
    const handle = await open(...args);
    if (args[0] === canonical) {
      const read = handle.read.bind(handle);
      handle.read = async (...readArgs) => {
        const result = await read(...readArgs);
        if (!changed) {
          changed = true;
          await fs.rename(item.file, item.file + '.old');
          await fs.writeFile(item.file, Buffer.alloc(8193, 0x32));
        }
        return result;
      };
    }
    return handle;
  });
  await assert.rejects(loose.readChunk(item, 0, 32), /changed|replaced/);
  assert.equal(changed, true);
  assert.equal(loose.inspectRangeReadCache().activeHandles, 0);
  t.mock.restoreAll();
  await fs.unlink(item.file);
  await fs.symlink(item.file + '.old', item.file);
  assert.deepEqual((await loose.readChunk(item, 0, 32)).chunk, Buffer.alloc(32, 0x32));
});

test('Windows缺失pathname设备号可读取同一对象，descriptor完整身份变更拒绝复用', async t => {
  const item = await publishLoose(Buffer.alloc(4096, 0x33));
  const canonical = await fs.realpath(item.file);
  const lstat = fs.lstat, open = fs.open;
  let armed = false;
  const platform = Object.getOwnPropertyDescriptor(process, 'platform');
  t.mock.method(fs, 'lstat', async (target, ...args) => {
    const value = await lstat(target, ...args);
    if (String(target) === canonical && args[0]?.bigint) value.dev = 0n;
    return value;
  });
  t.mock.method(fs, 'open', async (target, ...args) => {
    const handle = await open(target, ...args);
    if (String(target) === canonical) {
      const stat = handle.stat.bind(handle), read = handle.read.bind(handle);
      let changed = false;
      handle.stat = async (...statArgs) => {
        const value = await stat(...statArgs);
        value.dev = 742408122n + (changed ? 1n << 32n : 0n);
        return value;
      };
      handle.read = async (...readArgs) => {
        const value = await read(...readArgs);
        if (armed) changed = true;
        return value;
      };
    }
    return handle;
  });
  Object.defineProperty(process, 'platform', { ...platform, value: 'win32' });
  try {
    assert.deepEqual((await loose.readChunk(item, 0, 32)).chunk, Buffer.alloc(32, 0x33));
    armed = true;
    await assert.rejects(loose.readChunk(item, 32, 32), /changed|replaced/);
    assert.equal(loose.inspectRangeReadCache().activeHandles, 0);
  } finally { Object.defineProperty(process, 'platform', platform); }
});

test('Context worker保留空正文、重复身份、顺序和返回Buffer隔离', async () => {
  const conversationId = 'cache-content';
  const bodies = [Buffer.from('first'), Buffer.alloc(0), Buffer.from('first'), Buffer.from('last')];
  const prepared = await store.prepareBatch(database, bodies.map(content => ({ content, contentType: 'application/x-ci-context' })));
  const steps = [repo('Conversation').insert({ id: conversationId, title: conversationId, status: 'active', created_at: NOW, updated_at: NOW }),
    ...new Map(prepared.filter(item => item.insert).map(item => [item.metadata.id, item.insert])).values()];
  const nodes = [];
  for (let index = 0; index < bodies.length; index++) {
    steps.push(repo('ContextSegment').insert({ id: `cache-segment-${index}`, content_object_id: prepared[index].metadata.id,
      segment_kind: 'system', created_at: NOW }));
    nodes.push({ id: `cache-node-${index}`, parent_node_id: index ? `cache-node-${index - 1}` : null,
      segment_id: `cache-segment-${index}`, created_at: NOW });
  }
  steps.push(repo('ContextSequenceNode').ensureContextSequenceNodes(nodes),
    repo('ContextSequenceRoot').insertWithNextSequence({ id: 'cache-root', conversation_id: conversationId,
      root_node_id: 'cache-node-3', tail_node_id: null, tail_segment_count: 0n, segment_count: 4n,
      estimated_tokens: 4n, created_at: NOW }, { column: 'root_seq', scope: { conversation_id: conversationId } }));
  await database.transaction(steps);
  const read = async () => (await database.materializeContextContent('cache-root')).snapshot.records;
  const first = await read();
  assert.deepEqual(first.map(item => Buffer.from(item.content)), bodies);
  assert.equal(first[0].contentObject.id, first[2].contentObject.id);
  for (const item of first) item.content.fill(0xff);
  assert.deepEqual((await read()).map(item => Buffer.from(item.content)), bodies);
});

test('packed与loose的8192字节分界保留空正文、别名和原字节', async () => {
  const bodies = [Buffer.alloc(0), Buffer.alloc(8192, 0x41), Buffer.alloc(8193, 0x42)];
  const prepared = await store.prepareBatch(database, bodies.map(content => ({ content, contentType: 'application/x-ci-boundary' })));
  await database.transaction(prepared.map(item => item.insert).filter(Boolean));
  for (let index = 0; index < bodies.length; index++) assert.deepEqual(await store.read(prepared[index].metadata), bodies[index]);
  const pathOf = item => path.join(binding.paths.casRootPath, ...item.storage_key.split('/'));
  await assert.rejects(fs.stat(pathOf(prepared[1].metadata)), { code: 'ENOENT' });
  assert.ok((await fs.stat(pathOf(prepared[2].metadata))).isFile());
  const alias = await store.ingest(database, bodies[1], 'application/x-ci-alias');
  assert.notEqual(alias.id, prepared[1].metadata.id);
  assert.equal(alias.storage_key, prepared[1].metadata.storage_key);
  const copy = await store.read(alias); copy.fill(0);
  assert.deepEqual(await store.read(alias), bodies[1]);
});

test('CAS提交后登记前失败不发布Runtime引用，重试复用已持久化孤儿', async t => {
  const bytes = Buffer.from('publication-gap');
  const identity = store.identity(bytes, 'application/x-ci-publication');
  const publisher = database.casAccess.packed;
  const publish = publisher.publishBatch.bind(publisher);
  t.mock.method(publisher, 'publishBatch', async entries => {
    await publish(entries);
    throw new Error('CAS committed before Runtime reference');
  });
  await assert.rejects(store.ingest(database, bytes, 'application/x-ci-publication'), /before Runtime reference/);
  assert.equal((await database.snapshot([repo('ContentObject').get(identity.id)])).snapshot[0], null);
  t.mock.restoreAll();
  await reopen();
  const metadata = await store.ingest(database, bytes, 'application/x-ci-publication');
  assert.equal(metadata.id, identity.id);
  assert.deepEqual(await store.read(metadata), bytes);
  const reader = new Database(packedFile(), { readonly: true });
  try { assert.equal(reader.prepare('SELECT COUNT(*) FROM cas_body WHERE digest = ?').pluck().get(Buffer.from(metadata.sha256, 'hex')), 1); }
  finally { reader.close(); }
});

test('packed坏正文不会回退到同digest的正确loose副本', async () => {
  const bytes = Buffer.from('packed-corruption-proof');
  const metadata = await store.ingest(database, bytes, 'application/x-ci-corrupt');
  await loose.publish(bytes, 'application/x-ci-corrupt');
  await database.close();
  const connection = new Database(packedFile());
  try { connection.prepare('UPDATE cas_body SET body = ? WHERE digest = ?').run(Buffer.alloc(bytes.length, 0x78), Buffer.from(metadata.sha256, 'hex')); }
  finally { connection.close(); }
  database = await kernel.RuntimeDatabase.open(authority);
  store = kernel.ContentAddressedStore.forDatabase(authority, database);
  try { await assert.rejects(store.read(metadata), /digest mismatch/); }
  finally {
    const restore = new Database(packedFile());
    try { restore.prepare('UPDATE cas_body SET body = ? WHERE digest = ?').run(bytes, Buffer.from(metadata.sha256, 'hex')); }
    finally { restore.close(); }
  }
});

test('未知packed容器DDL拒绝打开，保留既有正文与结构', async () => {
  await database.close();
  const connection = new Database(packedFile());
  let before;
  try {
    connection.exec('CREATE TABLE unsupported_format (id INTEGER)');
    before = connection.prepare('SELECT digest, body FROM cas_body ORDER BY digest').all();
  } finally { connection.close(); }
  await assert.rejects(kernel.RuntimeDatabase.open(authority), /schema does not match/);
  const after = new Database(packedFile());
  try {
    assert.deepEqual(after.prepare('SELECT digest, body FROM cas_body ORDER BY digest').all(), before);
    assert.equal(after.prepare("SELECT COUNT(*) FROM sqlite_master WHERE name = 'unsupported_format'").pluck().get(), 1);
    after.exec('DROP TABLE unsupported_format');
  } finally { after.close(); }
  database = await kernel.RuntimeDatabase.open(authority);
  store = kernel.ContentAddressedStore.forDatabase(authority, database);
});

test('worker正文占用按记录分组，同字节的两个类型分别计入', async () => {
  await store.ingest(database, 'aa', 'application/x-ci-usage-a');
  await store.ingest(database, 'xxxx', 'application/x-ci-usage-a');
  await store.ingest(database, 'xxxx', 'application/x-ci-usage-b');
  const rows = (await database.contentUsage()).filter(row => row.contentType.startsWith('application/x-ci-usage-'));
  assert.deepEqual(rows, [
    { contentType: 'application/x-ci-usage-a', count: '2', bytes: '6', maxBytes: '4' },
    { contentType: 'application/x-ci-usage-b', count: '1', bytes: '4', maxBytes: '4' }
  ]);
});
