// Seven storage-authority scenarios; the calling suite owns the test declarations.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import Module, { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const compiled = path.resolve(process.env.LIMCODE_TEST_EXTENSION_ROOT ?? 'dist/extension');
const storageFile = file => require(path.join(compiled, 'backend/capabilities/vscodeStorage', file));
const claims = require(path.join(compiled, 'backend/reliableKernel/runtimeClaimPrimitives.js'));

class FileUri {
  constructor(filePath) {
    this.scheme = 'file';
    this.fsPath = path.resolve(filePath);
    this.path = this.fsPath.replaceAll('\\', '/');
  }
  static file(filePath) { return new FileUri(filePath); }
  static joinPath(root, ...parts) { return new FileUri(path.join(root.fsPath, ...parts)); }
  toString() { return `file://${this.path}`; }
}

// The production storage modules need VSCode's URI and directory API; file reads/writes remain native.
const vscode = {
  Uri: FileUri, FileType: { File: 1, Directory: 2 },
  workspace: { fs: {
    createDirectory: uri => fsp.mkdir(uri.fsPath, { recursive: true }),
    readDirectory: async uri => (await fsp.readdir(uri.fsPath, { withFileTypes: true }))
      .map(entry => [entry.name, entry.isDirectory() ? 2 : 1]),
    readFile: uri => fsp.readFile(uri.fsPath),
    writeFile: (uri, bytes) => fsp.writeFile(uri.fsPath, bytes),
    delete: uri => fsp.rm(uri.fsPath, { recursive: true })
  } }
};
const nativeLoad = Module._load;
let records, globalStatus, json, durableWrite;
try {
  Module._load = function (request, parent, isMain) {
    return request === 'vscode' ? vscode : nativeLoad.call(this, request, parent, isMain);
  };
  records = storageFile('recordStore.js');
  globalStatus = storageFile('globalStatus.js');
  json = storageFile('json.js');
  durableWrite = storageFile('durableWrite.js');
} finally { Module._load = nativeLoad; }

export async function claimReplacementAfterWindowsRename(t) {
  const root = await temporaryRoot(t, 'claim-replacement');
  const claimPath = path.join(root, 'runtime-admission');
  const ownerPath = path.join(claimPath, 'owner.json');
  await fsp.mkdir(claimPath);
  await fsp.writeFile(ownerPath, JSON.stringify({ ownerToken: 'original' }));
  const nativeRename = fsp.rename;
  const platform = Object.getOwnPropertyDescriptor(process, 'platform');
  let failures = 0;
  try {
    Object.defineProperty(process, 'platform', { ...platform, value: 'win32' });
    fsp.rename = async (source, destination) => {
      if (source === claimPath && failures++ === 0) {
        await fsp.writeFile(ownerPath, JSON.stringify({ ownerToken: 'replacement' }));
        throw Object.assign(new Error('injected Windows sharing violation'), {
          code: 'EPERM', syscall: 'rename', path: source, dest: destination
        });
      }
      return nativeRename(source, destination);
    };
    await assert.rejects(claims.releaseClaimRecord(
      claimPath, 'owner.json', 'original',
      value => value && typeof value.ownerToken === 'string' ? value : undefined,
      cause => Object.assign(new Error('invalid claim'), { cause }),
      () => Object.assign(new Error('claim owner changed'), { code: 'claim-mismatch' })
    ), { code: 'claim-mismatch' });
    assert.equal(failures, 1);
    assert.deepEqual(JSON.parse(await fsp.readFile(ownerPath, 'utf8')), { ownerToken: 'replacement' });
  } finally {
    fsp.rename = nativeRename;
    Object.defineProperty(process, 'platform', platform);
  }
}

export async function crashedOwnerWithTwoSuccessors(t) {
  const children = [];
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), 'limcode-ci-record-successors-'));
  t.after(async () => {
    for (const worker of children) {
      if (worker.child.exitCode === null && worker.child.signalCode === null) worker.child.kill('SIGKILL');
      await worker.finished.catch(() => undefined);
    }
    await fsp.rm(root, { recursive: true, force: true });
  });
  const holder = startWorker('holder', root);
  children.push(holder);
  await holder.wait('held');
  holder.child.kill('SIGKILL');
  await holder.finished;
  const lockPath = path.join(root, 'index.json.lock');
  const ownerPath = path.join(lockPath, 'owner.json');
  const deadOwner = JSON.parse(await fsp.readFile(ownerPath, 'utf8'));
  deadOwner.createdAt = Date.now() - 31_000;
  await fsp.writeFile(ownerPath, JSON.stringify(deadOwner));

  const first = startWorker('writer', root, 'successor-a');
  const second = startWorker('writer', root, 'successor-b');
  children.push(first, second);
  await Promise.all([first.wait('ready'), second.wait('ready')]);
  first.child.send({ type: 'load' });
  second.child.send({ type: 'load' });
  await Promise.all([first.wait('loaded'), second.wait('loaded')]);
  first.child.send({ type: 'commit' });
  second.child.send({ type: 'commit' });
  const results = await Promise.all([first.finished, second.finished]);
  assert.deepEqual(results.map(result => result.code), [0, 0]);

  const snapshot = await records.loadRecordStoreSnapshot(FileUri.file(root), FileUri.file(path.join(root, 'index.json')), 'record');
  assert.deepEqual(snapshot.records.map(record => record.id).sort(), ['successor-a', 'successor-b']);
  const index = JSON.parse(await fsp.readFile(path.join(root, 'index.json'), 'utf8'));
  assert.equal(index.records.length, 2);
  assert.equal(new Set(index.records.map(record => record.file)).size, 2);
  assert.equal((await fsp.readdir(path.join(root, 'records'))).filter(name => name.endsWith('.json')).length, 2);
  for (const entry of index.records) {
    const body = JSON.parse(await fsp.readFile(path.join(root, ...entry.file.split('/')), 'utf8'));
    assert.equal(body.record.id, entry.id);
    assert.ok(body.record.writerPid > 0);
  }
  const fence = `index.json.lock.generation-owner-${deadOwner.ownerToken}`;
  assert.deepEqual((await fsp.readdir(root)).filter(name => name.startsWith('index.json.lock')), [fence]);
  assert.deepEqual(JSON.parse(await fsp.readFile(path.join(root, fence, 'owner.json'), 'utf8')), deadOwner);
}

export async function staleRecordRevisionPreservesCommit(t) {
  const directory = await temporaryRoot(t, 'record-revision');
  const root = FileUri.file(directory);
  const index = FileUri.joinPath(root, 'index.json');
  const first = await commitRecords(root, index, [{ id: 'provider-a', name: 'A' }], records.missingRecordStoreRevision(index));
  const second = await commitRecords(root, index, [...first.records, { id: 'provider-b', name: 'B' }], first.revision);
  await assert.rejects(commitRecords(root, index, [{ id: 'provider-a', name: 'stale' }], first.revision),
    error => error.settingsRevisionConflict === true);
  const stored = await records.loadRecordStoreSnapshot(root, index, 'record');
  assert.equal(stored.revision, second.revision);
  assert.deepEqual(stored.records, [{ id: 'provider-a', name: 'A' }, { id: 'provider-b', name: 'B' }]);
}

export async function staleCommonRevisionPreservesRootAndProxy(t) {
  const directory = await temporaryRoot(t, 'common-revision');
  const context = () => {
    let projected;
    return { globalStorageUri: FileUri.file(directory), globalState: {
      get: () => projected, update: async (_key, value) => { projected = value; }
    } };
  };
  const currentHost = context(), oldHost = context();
  const initial = await globalStatus.loadCommittedGlobalStatus(currentHost);
  const old = await globalStatus.loadCommittedGlobalStatus(oldHost);
  const currentRoot = path.join(directory, 'current-data');
  const committed = await globalStatus.saveGlobalStatusExpected(currentHost, currentRoot, 'http://current-proxy.example',
    globalStatus.globalStatusRevision(initial));
  await assert.rejects(globalStatus.saveGlobalStatusExpected(oldHost, old.dataRootPath, 'http://stale-proxy.example',
    globalStatus.globalStatusRevision(old)), error => error.settingsRevisionConflict === true);
  const reloaded = await globalStatus.loadCommittedGlobalStatus(oldHost);
  assert.equal(reloaded.dataRootPath, currentRoot);
  assert.equal(reloaded.proxy, 'http://current-proxy.example');
  assert.equal(globalStatus.globalStatusRevision(reloaded), globalStatus.globalStatusRevision(committed.current));
  const persisted = JSON.parse(await fsp.readFile(globalStatus.globalStatusFileUri(oldHost).fsPath, 'utf8'));
  assert.equal(persisted.dataRootPath, currentRoot);
  assert.equal(persisted.proxy, 'http://current-proxy.example');
}

export async function asyncReleasePreservesReplacementOwner(t) {
  const root = await temporaryRoot(t, 'lock-replacement');
  const indexPath = path.join(root, 'index.json');
  const lockPath = `${indexPath}.lock`;
  const ownerPath = path.join(lockPath, 'owner.json');
  const nativeRename = fsp.rename, nativeRead = fsp.readFile, nativeNow = Date.now;
  let replacement, replacementMoved = false, actions = 0, ownerReads = 0, clockOffset = 0;
  try {
    fsp.rename = async (source, destination) => {
      if (String(source) === lockPath) {
        if (replacement) replacementMoved = true;
        else {
          await nativeRename(source, path.join(root, 'released-original'));
          replacement = { ownerToken: 'replacement', pid: process.pid, createdAt: nativeNow(), indexPath };
          await fsp.mkdir(lockPath);
          await fsp.writeFile(ownerPath, JSON.stringify(replacement));
          throw Object.assign(new Error('injected release rename busy'), { code: 'EBUSY', syscall: 'rename', path: source });
        }
      }
      return nativeRename(source, destination);
    };
    await assert.rejects(records.withRecordStoreTransaction(FileUri.file(indexPath), async () => {
      actions += 1;
      await fsp.writeFile(path.join(root, 'committed.txt'), 'saved');
    }), error => /owner changed/.test(error.cause?.message));
    // The next queued action first recovers the completed release. Advance its deadline only
    // after it has read the live replacement; this tests refusal without waiting thirty seconds.
    Date.now = () => nativeNow() + clockOffset;
    fsp.readFile = async (target, ...options) => {
      const raw = await nativeRead(target, ...options);
      if (String(target) === ownerPath && ++ownerReads === 2) clockOffset = 31_000;
      return raw;
    };
    await assert.rejects(records.withRecordStoreTransaction(FileUri.file(indexPath), async () => { actions += 1; }),
      /Timed out waiting for record store lock/);
    assert.equal(actions, 1);
    assert.equal(replacementMoved, false);
    assert.deepEqual(JSON.parse(await nativeRead(ownerPath, 'utf8')), replacement);
    assert.equal(await nativeRead(path.join(root, 'committed.txt'), 'utf8'), 'saved');
  } finally {
    fsp.rename = nativeRename;
    fsp.readFile = nativeRead;
    Date.now = nativeNow;
  }
}

export async function asyncJsonFsyncPreservesPublishedFile(t) {
  const root = await temporaryRoot(t, 'async-json');
  const target = path.join(root, 'settings.json');
  const nativeOpen = fsp.open, nativeRename = fsp.rename;
  const events = [];
  let fail = false;
  try {
    fsp.open = async (file, ...options) => {
      const handle = await nativeOpen(file, ...options);
      if (String(file).startsWith(`${target}.`) && String(file).endsWith('.tmp')) {
        const nativeSync = handle.sync.bind(handle);
        handle.sync = async () => {
          events.push('fsync');
          if (fail) throw Object.assign(new Error('injected async disk I/O failure'), { code: 'EIO' });
          return nativeSync();
        };
      }
      return handle;
    };
    fsp.rename = async (source, destination) => {
      if (String(destination) === target) events.push('rename');
      return nativeRename(source, destination);
    };
    await json.writeJson(FileUri.file(target), { published: true });
    assert.deepEqual(events, ['fsync', 'rename']);
    const committed = await fsp.readFile(target, 'utf8');
    assert.deepEqual(JSON.parse(committed), { published: true });
    fail = true;
    await assert.rejects(json.writeJson(FileUri.file(target), { stale: true }), { code: 'EIO' });
    assert.equal(await fsp.readFile(target, 'utf8'), committed);
    assert.deepEqual(await fsp.readdir(root), ['settings.json']);
  } finally { fsp.open = nativeOpen; fsp.rename = nativeRename; }
}

export async function syncJsonFsyncPreservesPublishedFile(t) {
  const root = await temporaryRoot(t, 'sync-json');
  const target = path.join(root, 'settings.json');
  const nativeSync = fs.fsyncSync, nativeRename = fs.renameSync;
  const events = [];
  let fail = false;
  try {
    fs.fsyncSync = descriptor => {
      events.push('fsync');
      if (fail) throw Object.assign(new Error('injected synchronous disk I/O failure'), { code: 'EIO' });
      return nativeSync(descriptor);
    };
    fs.renameSync = (source, destination) => {
      if (String(destination) === target) events.push('rename');
      return nativeRename(source, destination);
    };
    durableWrite.writeFileAtomicDurableSync(target, JSON.stringify({ published: true }) + '\n');
    assert.ok(events.includes('fsync'));
    assert.ok(events.indexOf('fsync') < events.indexOf('rename'));
    assert.ok(events.includes('rename'));
    const committed = fs.readFileSync(target, 'utf8');
    assert.deepEqual(JSON.parse(committed), { published: true });
    fail = true;
    assert.throws(() => durableWrite.writeFileAtomicDurableSync(target, JSON.stringify({ stale: true }) + '\n'), { code: 'EIO' });
    assert.equal(fs.readFileSync(target, 'utf8'), committed);
    assert.deepEqual(await fsp.readdir(root), ['settings.json']);
  } finally { fs.fsyncSync = nativeSync; fs.renameSync = nativeRename; }
}

async function temporaryRoot(t, name) {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), `limcode-ci-${name}-`));
  t.after(() => fsp.rm(root, { recursive: true, force: true }));
  return root;
}

function commitRecords(root, index, values, expectedRevision) {
  return records.commitRecordStoreSnapshot(root, index, values, 'record', record => record.name ?? record.id,
    { expectedRevision, section: 'providers', pruneMissing: true });
}

function startWorker(mode, root, id = '') {
  const child = spawn(process.execPath, [fileURLToPath(import.meta.url), '--record-store-child', mode, root, id], {
    cwd: process.cwd(), env: process.env, stdio: ['ignore', 'ignore', 'pipe', 'ipc'], windowsHide: true
  });
  const messages = new Set(), pending = new Map();
  let stderr = '';
  child.stderr.on('data', bytes => { stderr += bytes; });
  child.on('message', message => {
    messages.add(message.type);
    pending.get(message.type)?.();
  });
  const finished = new Promise((resolve, reject) => {
    child.once('error', reject);
    child.once('exit', (code, signal) => code === 0 || mode === 'holder' && signal === 'SIGKILL'
      ? resolve({ code, signal }) : reject(new Error(`storage ${mode} failed (${code}, ${signal}): ${stderr}`)));
  });
  finished.catch(() => undefined);
  return { child, finished, wait(type) {
    if (messages.has(type)) return Promise.resolve();
    return Promise.race([
      new Promise(resolve => { pending.set(type, resolve); }),
      finished.then(() => { throw new Error(`storage ${mode} exited before ${type}`); })
    ]);
  } };
}

async function waitForParent(type) {
  await new Promise(resolve => {
    const receive = message => {
      if (message.type !== type) return;
      process.off('message', receive);
      resolve();
    };
    process.on('message', receive);
  });
}

async function runWorker(mode, rootPath, id) {
  const root = FileUri.file(rootPath), index = FileUri.joinPath(root, 'index.json');
  if (mode === 'holder') {
    await records.withRecordStoreTransaction(index, async () => {
      process.on('message', () => undefined);
      process.send({ type: 'held' });
      await new Promise(() => undefined);
    });
    return;
  }
  const load = waitForParent('load');
  process.send({ type: 'ready' });
  await load;
  let snapshot = await records.loadRecordStoreSnapshot(root, index, 'record');
  const commit = waitForParent('commit');
  process.send({ type: 'loaded' });
  await commit;
  const save = () => commitRecords(root, index, [...(snapshot?.records ?? []), { id, writerPid: process.pid }],
    snapshot?.revision ?? records.missingRecordStoreRevision(index));
  try { await save(); }
  catch (error) {
    if (!error.settingsRevisionConflict) throw error;
    // Exactly two writers share one initial snapshot: only one fresh read can be necessary.
    snapshot = await records.loadRecordStoreSnapshot(root, index, 'record');
    await save();
  }
  process.disconnect();
}

if (process.argv[2] === '--record-store-child') {
  try { await runWorker(process.argv[3], process.argv[4], process.argv[5]); }
  catch (error) { console.error(error?.stack ?? error); process.exitCode = 1; process.disconnect?.(); }
}
