import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import test from 'node:test';
import { Worker } from 'node:worker_threads';
import { createConfigurationRoot, removeConfigurationRoot, seedConversations } from './fixtures/runtime-merge-fixture.mjs';
import { createFixture, createLimCodeTarget, planWithRuntime, relocate } from './runtime-data-root-relocation-fixture.mjs';

const require = createRequire(import.meta.url);
const compiled = path.resolve(process.env.LIMCODE_TEST_EXTENSION_ROOT ?? 'dist/extension');
const load = file => require(path.join(compiled, 'backend/reliableKernel', file));
const kernel = load('index.js');
const Database = require('better-sqlite3');
const { PACKED_CAS_FILE } = load('packedCasWorkerProtocol.js');
const { PackedCasWorkerClient } = load('packedCasWorkerClient.js');
const { locateLocalRuntimeDataSet, openRuntimeDataSetHistory } = load('runtimeDataSetHistory.js');
const { mergeHistoricalDataSetsOnline } = load('runtimeDataSetMerge.js');
const { planRuntimeBackupCleanup } = load('runtimeBackupCleanup.js');
const repo = name => kernel.DOMAIN_REPOSITORIES.domain(name);
const NOW = '2026-10-05T00:00:00.000Z';
const packedFile = binding => path.join(binding.paths.casRootPath, PACKED_CAS_FILE);
const looseFile = (binding, object) => path.join(binding.paths.casRootPath, ...object.storage_key.split('/'));

async function fixture(run) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'limcode-packed-cas-'));
  const authority = new kernel.RootAuthority(() => path.join(root, 'runtime'));
  const binding = await kernel.initializeEmptyRuntimeRoot(authority);
  let database = await kernel.RuntimeDatabase.open(authority);
  try {
    await run({ root, authority, binding, database,
      reopen: async () => { await database.close(); return database = await kernel.RuntimeDatabase.open(authority); } });
  } finally { await database.close(); await fs.rm(root, { recursive: true, force: true }); }
}

async function nativeLooseIdentityDiagnostic(binding, object, bytes) {
  return new Promise((resolve, reject) => {
    const worker = new Worker(`
      const { parentPort, workerData } = require('node:worker_threads');
      const fs = require('node:fs');
      const { PackedCasStore } = require(workerData.module);
      const fields = info => Object.fromEntries([
        ...['dev', 'ino', 'size', 'mtimeNs', 'ctimeNs', 'mode'].map(key => [key, String(info[key])]),
        ['devHex', info.dev.toString(16)], ['inoHex', info.ino.toString(16)], ['isFile', info.isFile()]
      ]);
      (async () => {
        const trace = [], descriptors = new Set();
        const original = { statSync: fs.statSync, fstatSync: fs.fstatSync, openSync: fs.openSync };
        const record = (api, info) => { if (trace.length < 8) trace.push({ api, ...fields(info) }); return info; };
        const store = new PackedCasStore(workerData.binding);
        let publication;
        try {
          fs.statSync = (file, ...args) => {
            const info = original.statSync(file, ...args);
            return file === workerData.file ? record('statSync', info) : info;
          };
          fs.openSync = (file, ...args) => {
            const descriptor = original.openSync(file, ...args);
            if (file === workerData.file) descriptors.add(descriptor);
            return descriptor;
          };
          fs.fstatSync = (descriptor, ...args) => {
            const info = original.fstatSync(descriptor, ...args);
            return descriptors.has(descriptor) ? record('fstatSync', info) : info;
          };
          store.publishBatch([{ object: workerData.object, bytes: Buffer.from(workerData.bytes) }]);
          publication = { status: 'succeeded' };
        } catch (error) {
          publication = { status: 'failed', name: error.name, code: error.code };
        } finally { Object.assign(fs, original); store.close(); }
        const asyncProbe = {};
        try {
          asyncProbe.before = fields(await fs.promises.stat(workerData.file, { bigint: true }));
          const handle = await fs.promises.open(workerData.file, 'r');
          try { asyncProbe.opened = fields(await handle.stat({ bigint: true })); }
          finally { await handle.close(); }
          asyncProbe.after = fields(await fs.promises.stat(workerData.file, { bigint: true }));
        } catch (error) { asyncProbe.error = { name: error.name, code: error.code }; }
        parentPort.postMessage({ node: process.version, uv: process.versions.uv, platform: process.platform, release: require('node:os').release(),
          arch: process.arch, expectedBytes: String(workerData.object.byte_length), publication, trace, asyncProbe });
      })().catch(error => { parentPort.postMessage({ diagnosticError: { name: error.name, code: error.code } }); });
    `, { eval: true, resourceLimits: { maxOldGenerationSizeMb: 32 }, workerData: {
      module: path.join(compiled, 'backend/reliableKernel/packedCasStore.js'), binding, object, bytes,
      file: looseFile(binding, object)
    } });
    let message, failure, timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      void worker.terminate().catch(error => { failure = error; });
    }, 10_000);
    worker.on('message', value => { message = value; });
    worker.on('error', error => { failure = error; });
    worker.on('exit', code => {
      clearTimeout(timer);
      if (timedOut || failure || code !== 0) reject(failure ?? new Error(timedOut ? 'CAS diagnostic worker timed out' : `CAS diagnostic worker exited ${code}`));
      else resolve(message);
    });
  });
}

test('packed CAS preserves identities, boundary bytes, aliases, batch ownership and close fencing', async () => fixture(async f => {
  const store = kernel.ContentAddressedStore.forDatabase(f.authority, f.database);
  const other = kernel.ContentAddressedStore.forDatabase(f.authority, f.database);
  assert.equal(store.byteAccess, other.byteAccess, 'facades borrow one Runtime-owned worker');
  await assert.rejects(fs.stat(packedFile(f.binding)), { code: 'ENOENT' });
  await kernel.ContentAddressedStore.loose(f.authority, f.binding).publish('legacy body', 'text/plain');
  const legacy = await store.ingest(f.database, 'legacy body', 'text/legacy-alias').catch(async error => {
    const bytes = Buffer.from('legacy body');
    let diagnostic;
    try { diagnostic = await nativeLooseIdentityDiagnostic(f.binding, store.identity(bytes, 'text/legacy-alias'), bytes); }
    catch (failure) { diagnostic = { diagnosticError: { name: failure.name, code: failure.code } }; }
    error.message += '; native loose identity diagnostic: ' + JSON.stringify(diagnostic);
    throw error;
  });
  await assert.rejects(fs.stat(packedFile(f.binding)), { code: 'ENOENT' }, 'reusing loose bytes creates no container');
  assert.equal(await fs.readFile(looseFile(f.binding, legacy), 'utf8'), 'legacy body');

  const bodies = [Buffer.alloc(0), Buffer.alloc(8192, 0xa5), Buffer.alloc(8193, 0x19), Buffer.from([0, 255, 1, 128])];
  const publish = f.database.casAccess.packed.publishBatch.bind(f.database.casAccess.packed);
  let batches = 0;
  f.database.casAccess.packed.publishBatch = entries => { batches += 1; return publish(entries); };
  const prepared = await store.prepareBatch(f.database, bodies.map(content => ({ content, contentType: 'application/octet-stream' })));
  assert.equal(batches, 1, 'one supplied batch remains one small-body publication transaction');
  await f.database.transaction(prepared.map(entry => entry.insert));
  for (let index = 0; index < bodies.length; index += 1) {
    const metadata = prepared[index].metadata;
    assert.deepEqual(await store.read(metadata), bodies[index]);
    const identity = store.identity(bodies[index], metadata.content_type);
    assert.equal(metadata.id, identity.id);
    assert.equal(metadata.sha256, createHash('sha256').update(bodies[index]).digest('hex'));
    if (bodies[index].length <= 8192) await assert.rejects(fs.stat(looseFile(f.binding, metadata)), { code: 'ENOENT' });
  }
  assert.ok((await fs.stat(looseFile(f.binding, prepared[2].metadata))).isFile());
  const alias = await store.ingest(f.database, bodies[3], 'application/alias');
  assert.notEqual(alias.id, prepared[3].metadata.id);
  assert.equal(alias.storage_key, prepared[3].metadata.storage_key);
  const copy = await store.read(alias); copy.fill(9);
  assert.deepEqual(await other.read(alias), bodies[3]);
  assert.deepEqual((await store.readChunk(alias, 1, 2)).chunk, bodies[3].subarray(1, 3));
  assert.equal((await store.readChunk(alias, 4, 5)).hasMore, false);
  await assert.rejects(store.readChunk(alias, 5, 1), /offset/);

  let release;
  const drain = new Promise(resolve => { release = resolve; });
  let entered;
  const closing = new Promise(resolve => { entered = resolve; });
  const closePacked = f.database.casAccess.packed.close.bind(f.database.casAccess.packed);
  f.database.casAccess.packed.close = async () => { entered(); await drain; await closePacked(); };
  const close = f.database.close();
  await closing;
  await assert.rejects(kernel.RuntimeDatabase.open(f.authority), /already open/);
  release(); await close;
  await assert.rejects(store.read(alias), /closing|closed|ownership/);
  const inspected = new Database(packedFile(f.binding), { readonly: true });
  try {
    assert.equal(inspected.prepare('SELECT COUNT(*) FROM cas_body').pluck().get(), 3);
    assert.equal(inspected.prepare("SELECT COUNT(*) FROM cas_body WHERE typeof(digest) != 'blob' OR length(digest) != 32").pluck().get(), 0);
  } finally { inspected.close(); }
  const reopened = await f.reopen();
  assert.deepEqual(await kernel.ContentAddressedStore.forDatabase(f.authority, reopened).read(alias), bodies[3]);
}));

test('publication acknowledgement failures leave no Runtime reference; exact retries reuse orphan bytes', async () => fixture(async f => {
  let store = kernel.ContentAddressedStore.forDatabase(f.authority, f.database);
  const publisher = f.database.casAccess.packed;
  const publish = publisher.publishBatch.bind(publisher);
  const identity = store.identity('retry without another external action', 'text/plain');
  publisher.publishBatch = async () => { throw new Error('before CAS acknowledgement'); };
  await assert.rejects(store.ingest(f.database, 'retry without another external action', 'text/plain'), /before CAS/);
  assert.equal((await f.database.snapshot([repo('ContentObject').get(identity.id)])).snapshot[0], null);
  publisher.publishBatch = async entries => { await publish(entries); throw new Error('after CAS commit before Runtime reference'); };
  await assert.rejects(store.ingest(f.database, 'retry without another external action', 'text/plain'), /after CAS commit/);
  assert.equal((await f.database.snapshot([repo('ContentObject').get(identity.id)])).snapshot[0], null);
  publisher.publishBatch = publish;
  const reopened = await f.reopen();
  store = kernel.ContentAddressedStore.forDatabase(f.authority, reopened);
  const metadata = await store.ingest(reopened, 'retry without another external action', 'text/plain');
  assert.equal(metadata.id, identity.id);
  assert.equal((await store.read(metadata)).toString(), 'retry without another external action');
  await reopened.close();
  const database = new Database(packedFile(f.binding), { readonly: true });
  try { assert.equal(database.prepare('SELECT COUNT(*) FROM cas_body').pluck().get(), 1); }
  finally { database.close(); }
}));

test('independent publishers dedupe a race, and fatal publisher exit fences cached Runtime reads', async () => fixture(async f => {
  const store = kernel.ContentAddressedStore.forDatabase(f.authority, f.database);
  const bytes = Buffer.from('racing immutable publication');
  const identity = store.identity(bytes, 'text/plain');
  const first = await PackedCasWorkerClient.open(f.binding);
  const second = await PackedCasWorkerClient.open(f.binding);
  try {
    await Promise.all([first, second].map(client => client.publishBatch([{ object: identity, bytes }])));
    await assert.rejects(second.publishBatch([{ object: identity, bytes: Buffer.alloc(bytes.length, 7) }]), /does not match/);
    assert.deepEqual(await first.readBytes(identity), bytes);
  } finally { await Promise.all([first.close(), second.close()]); }
  const metadata = await store.ingest(f.database, bytes, 'text/plain');
  await store.ingest(f.database, bytes, 'text/alias');
  assert.deepEqual(await store.read(metadata), bytes); // Populate the facade cache before failure.
  await f.database.casAccess.packed.worker.terminate();
  await assert.rejects(store.read(metadata), /closing|closed|exited|ownership/);
  await assert.rejects(kernel.RuntimeDatabase.open(f.authority), /already open/);
  const reopened = await f.reopen();
  assert.deepEqual(await kernel.ContentAddressedStore.forDatabase(f.authority, reopened).read(metadata), bytes);
  await reopened.close();
  const database = new Database(packedFile(f.binding), { readonly: true });
  try { assert.equal(database.prepare('SELECT COUNT(*) FROM cas_body').pluck().get(), 1); }
  finally { database.close(); }
}));

test('packed corruption wins over a valid loose duplicate; FULL and bounded per-object verification use the worker', async () => fixture(async f => {
  const bytes = Buffer.from('small immutable body');
  const store = kernel.ContentAddressedStore.forDatabase(f.authority, f.database);
  const metadata = await store.ingest(f.database, bytes, 'text/plain');
  const looseBytes = Buffer.from('loose descriptor identity');
  const looseObject = store.identity(looseBytes, 'text/plain');
  await kernel.ContentAddressedStore.loose(f.authority, f.binding).publish(looseBytes, 'text/plain');
  await f.database.close();
  const result = await new Promise((resolve, reject) => {
    const worker = new Worker(`
      const { parentPort, workerData } = require('node:worker_threads');
      const assert = require('node:assert/strict');
      const fs = require('node:fs');
      const crypto = require('node:crypto');
      const original = crypto.createHash; let hashes = 0;
      crypto.createHash = (...args) => { hashes += 1; return original(...args); };
      const { PackedCasStore } = require(workerData.module);
      const store = new PackedCasStore(workerData.binding);
      const before = hashes;
      store.publishBatch([{ object: workerData.object, bytes: Buffer.from(workerData.bytes) }]);
      const appendHashes = hashes - before;
      store.readBytes(workerData.object);
      const full = store.database.pragma('synchronous', { simple: true });
      const proof = { appendHashes, readHashes: hashes - before - appendHashes, full };
      const platform = Object.getOwnPropertyDescriptor(process, 'platform');
      const stat = fs.statSync, fstat = fs.fstatSync;
      const nativeInode = stat(workerData.looseFile, { bigint: true }).ino;
      const device = 0x09abcdefn, inode = 0x20000000000000n;
      let fault, pathReads, descriptorReads;
      fs.statSync = (file, options) => {
        const info = stat(file, options);
        if (file === workerData.looseFile) {
          info.dev = (0x12345678n << 32n) | device;
          info.ino = inode;
          if (++pathReads > 1 && fault === 'path') info.dev += 1n << 32n;
        }
        return info;
      };
      fs.fstatSync = (descriptor, options) => {
        const info = fstat(descriptor, options);
        if (info.ino === nativeInode) {
          info.dev = device + (fault === 'device' ? 1n : 0n);
          if (fault === 'full-device') info.dev |= 0x12345678n << 32n;
          info.ino = inode + (fault === 'inode' || (++descriptorReads > 1 && fault === 'descriptor') ? 1n : 0n);
        }
        return info;
      };
      const publishLoose = () => {
        pathReads = descriptorReads = 0;
        return store.publishBatch([{ object: workerData.looseObject, bytes: Buffer.from(workerData.looseBytes) }]);
      };
      try {
        Object.defineProperty(process, 'platform', { value: 'win32' });
        assert.deepEqual(publishLoose(), ['loose'], 'Windows path/fd volume serial widths may differ');
        fault = 'full-device';
        assert.deepEqual(publishLoose(), ['loose'], 'equal full-width Windows device identities remain valid');
        for (fault of ['device', 'inode', 'path', 'descriptor']) {
          assert.throws(publishLoose, { code: 'packed-cas-corrupt', message: /changed during publication/ }, fault);
        }
        fault = undefined;
        Object.defineProperty(process, 'platform', { value: 'linux' });
        assert.throws(publishLoose, { code: 'packed-cas-corrupt' }, 'other platforms require full device identity');
      } finally {
        fs.statSync = stat; fs.fstatSync = fstat;
        Object.defineProperty(process, 'platform', platform);
        store.close();
      }
      parentPort.postMessage(proof);
    `, { eval: true, resourceLimits: { maxOldGenerationSizeMb: 32 }, workerData: {
      module: path.join(compiled, 'backend/reliableKernel/packedCasStore.js'), binding: f.binding, object: metadata, bytes,
      looseObject, looseBytes, looseFile: looseFile(f.binding, looseObject)
    } });
    let message;
    worker.on('message', value => { message = value; });
    worker.on('error', reject);
    worker.on('exit', code => code === 0 ? resolve(message) : reject(new Error(`CAS proof worker exited ${code}`)));
  });
  assert.deepEqual(result, { appendHashes: 0, readHashes: 1, full: 2 }, 'FULL configuration and per-request proof, not a power-loss test');
  await kernel.ContentAddressedStore.loose(f.authority, f.binding).publish(bytes, 'text/plain');
  const corrupt = new Database(packedFile(f.binding));
  try { corrupt.prepare('UPDATE cas_body SET body = ? WHERE digest = ?').run(Buffer.alloc(bytes.length, 9), Buffer.from(metadata.sha256, 'hex')); }
  finally { corrupt.close(); }
  const reopened = await f.reopen();
  await assert.rejects(kernel.ContentAddressedStore.forDatabase(f.authority, reopened).read(metadata), /digest mismatch/);
  await reopened.close();
  const unknown = new Database(packedFile(f.binding));
  try { unknown.exec('CREATE TABLE unsupported_format (id INTEGER)'); }
  finally { unknown.close(); }
  await assert.rejects(kernel.RuntimeDatabase.open(f.authority), /schema does not match/);
}));

async function addPackedMessage(dataSet, id, text) {
  const database = await kernel.RuntimeDatabase.open(dataSet.authority);
  try {
    const store = kernel.ContentAddressedStore.forDatabase(dataSet.authority, database);
    const metadata = await store.ingest(database, JSON.stringify({ role: 'user', parts: [{ text }] }), 'application/vnd.limcode.message+json');
    await database.transaction([
      repo('Conversation').insert({ id, title: id, status: 'active', created_at: NOW, updated_at: NOW }),
      repo('Message').insert({ id: `${id}_message`, created_at: NOW, updated_at: NOW, deleted_at: null }),
      repo('MessageRevision').insert({ id: `${id}_revision`, message_id: `${id}_message`, revision_seq: 1n, role: 'user', content_object_id: metadata.id, created_at: NOW }),
      repo('MessageCurrentRevisionLink').insert({ id: `${id}_current`, message_id: `${id}_message`, revision_id: `${id}_revision`, updated_at: NOW }),
      repo('MessagePartOfConversation').insert({ id: `${id}_member`, conversation_id: id, message_id: `${id}_message`, message_seq: 1n, created_at: NOW })
    ]);
    return metadata;
  } finally { await database.close(); }
}

async function coverageBackup(database, minutesAgo) {
  const stamp = new Date(Date.now() - minutesAgo * 60_000).toISOString().replace(/[-:.]/g, '');
  const directory = path.join(path.dirname(database.binding.paths.dataRootPath), 'merge-backups', `${stamp}-000001-${randomUUID().slice(0, 8)}`);
  await fs.mkdir(directory, { recursive: true });
  await fs.writeFile(path.join(directory, 'root-binding.json'), JSON.stringify(database.binding));
  const temporary = path.join(directory, `limcode.sqlite.${process.pid}.tmp`);
  await database.backupTo(temporary);
  for (const suffix of ['-wal', '-shm']) await fs.rm(`${temporary}${suffix}`, { force: true });
  await fs.rename(temporary, path.join(directory, 'limcode.sqlite'));
  return directory;
}

test('mixed loose and packed history survives logical merge and backup coverage', async () => {
  const f = await createConfigurationRoot();
  let current;
  try {
    await seedConversations(f.alpha, [{ id: 'legacy_source' }]);
    const located = await locateLocalRuntimeDataSet(f.paths, f.alpha.id);
    const legacyHistory = await openRuntimeDataSetHistory(f.paths, located);
    try { assert.equal((await legacyHistory.readMessages('legacy_source')).items.length, 2); }
    finally { await legacyHistory.close(); }
    await fs.writeFile(`${packedFile(f.alpha.binding)}-wal`, Buffer.alloc(0));
    try { await assert.rejects(openRuntimeDataSetHistory(f.paths, located), /伴随文件/); }
    finally { await fs.rm(`${packedFile(f.alpha.binding)}-wal`); }
    const metadata = await addPackedMessage(f.alpha, 'packed_source', 'packed history text');
    const history = await openRuntimeDataSetHistory(f.paths, await locateLocalRuntimeDataSet(f.paths, f.alpha.id));
    try { assert.equal((await history.readMessages('packed_source')).items[0].text, 'packed history text'); }
    finally { await history.close(); }
    current = await kernel.RuntimeDatabase.open(f.current.authority);
    const merged = await mergeHistoricalDataSetsOnline(f.paths, { configurationRootPath: f.root, database: current });
    assert.deepEqual([merged.failures, merged.blocked, merged.deferred], [[], [], []]);
    assert.equal(merged.merged.length, 1);
    assert.equal((await kernel.ContentAddressedStore.forDatabase(f.current.authority, current).read(metadata)).toString(),
      JSON.stringify({ role: 'user', parts: [{ text: 'packed history text' }] }));
    const backup = await coverageBackup(current, 180);
    await coverageBackup(current, 120);
    const cleanupOptions = { now: () => Date.now() + 61 * 60 * 1000 };
    const plan = await planRuntimeBackupCleanup(f.root, current, cleanupOptions);
    assert.deepEqual(plan.problems, []);
    const covered = plan.items.find(item => path.resolve(item.path) === backup);
    assert.equal(covered?.deletable, true, covered?.reason);
    await current.close();
    const broken = new Database(packedFile(f.current.binding));
    try { broken.prepare('DELETE FROM cas_body WHERE digest = ?').run(Buffer.from(metadata.sha256, 'hex')); }
    finally { broken.close(); }
    current = await kernel.RuntimeDatabase.open(f.current.authority);
    const missing = (await planRuntimeBackupCleanup(f.root, current, cleanupOptions)).items.find(item => path.resolve(item.path) === backup);
    assert.equal(missing?.deletable, false);
    assert.match(missing?.reason ?? '', /缺 1 个它引用的正文文件/);
  } finally { await current?.close(); await removeConfigurationRoot(f.root); }
});

test('relocation undo retains a receiving packed store and its appended orphan rows', async t => {
  const f = await createFixture(t, { withAlpha: false });
  const metadata = await addPackedMessage(f.current, 'packed_relocation', 'copied packed relocation body');
  const target = await createLimCodeTarget(path.join(f.base, 'receiving'));
  const existing = await addPackedMessage(target, 'packed_existing', 'receiving packed body');
  const before = await fs.stat(packedFile(target.binding));
  const plan = await planWithRuntime(f, target.scopeRoot);
  await assert.rejects(relocate(f, plan, { publish: async () => { throw new Error('pointer publication fixture failure'); } }), /pointer publication fixture failure/);
  const database = await kernel.RuntimeDatabase.open(target.authority);
  try {
    const store = kernel.ContentAddressedStore.forDatabase(target.authority, database);
    assert.equal((await store.read(existing)).toString(), JSON.stringify({ role: 'user', parts: [{ text: 'receiving packed body' }] }));
    assert.equal((await database.snapshot([repo('ContentObject').get(metadata.id)])).snapshot[0], null);
    assert.equal(await database.casAccess.containsExactLength(metadata), true, 'rolled-back body remains a harmless immutable orphan');
    assert.equal((await fs.stat(packedFile(target.binding))).ino, before.ino, 'undo never replaces/truncates the receiving container');
  } finally { await database.close(); }
});

test('packed foreign history reads and imports through a private snapshot without touching recorded paths', async () => {
  const home = await createConfigurationRoot();
  const source = await createConfigurationRoot();
  const copied = `${home.root}.limcode-copied-2026-10-05T00-00-00-000Z-12345678`;
  let database;
  try {
    const metadata = await addPackedMessage(source.current, 'foreign_packed', 'foreign packed bytes');
    await fs.cp(source.root, copied, { recursive: true });
    await removeConfigurationRoot(source.root); // Every recorded source path is now absent.
    const foreign = load('runtimeForeignHistory.js');
    const entry = (await foreign.inspectForeignRuntimeHistory({ configurationRootPath: home.root })).entries
      .find(item => item.location.containerPath === copied && item.dataSetId === source.current.binding.dataSetId);
    assert.equal(entry?.status, 'verified', entry?.reason);
    const root = await foreign.locateForeignRuntimeRoot(home.root, entry.location);
    const beforeNames = (await fs.readdir(root.located.casRootPath)).sort();
    const before = await fs.stat(path.join(root.located.casRootPath, PACKED_CAS_FILE));
    const history = await openRuntimeDataSetHistory(home.paths, root);
    try { assert.equal((await history.readMessages('foreign_packed')).items[0].text, 'foreign packed bytes'); }
    finally { await history.close(); }
    await load('runtimeForeignHistoryMerge.js').requestForeignRuntimeHistoryMerge(home.paths, {
      id: entry.id, location: entry.location, label: 'packed fixture',
      expectedDataSetId: root.recorded.dataSetId, expectedRootInstanceId: root.recorded.rootInstanceId
    });
    database = await kernel.RuntimeDatabase.open(home.current.authority);
    const result = await mergeHistoricalDataSetsOnline(home.paths, { configurationRootPath: home.root, database },
      { candidateIds: [entry.id], requested: true });
    assert.deepEqual([result.failures, result.blocked, result.deferred], [[], [], []]);
    assert.equal(result.merged.length, 1);
    const bytes = await kernel.ContentAddressedStore.forDatabase(home.current.authority, database).read(metadata);
    assert.equal(JSON.parse(bytes.toString()).parts[0].text, 'foreign packed bytes');
    await assert.rejects(fs.stat(looseFile(home.current.binding, metadata)), { code: 'ENOENT' });
    assert.deepEqual((await fs.readdir(root.located.casRootPath)).sort(), beforeNames);
    const after = await fs.stat(path.join(root.located.casRootPath, PACKED_CAS_FILE));
    assert.deepEqual([after.size, after.mtimeMs], [before.size, before.mtimeMs]);
  } finally {
    await database?.close();
    await removeConfigurationRoot(home.root);
    await removeConfigurationRoot(source.root);
    await fs.rm(copied, { recursive: true, force: true });
  }
});
