import assert from 'node:assert/strict';
import childProcess from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { Worker } from 'node:worker_threads';
import { createRequire } from 'node:module';

// SQLite's unix VFS keeps POSIX fcntl locks on the database and its -shm file (writer lock, reader
// marks, DMS). POSIX drops every lock a process holds on a file as soon as that process closes ANY
// descriptor of the file, so diagnostics running in the Extension Host must never open these files.
// The in-process connection lives in a worker_thread exactly like RuntimeDatabase; the competitor is
// a separate process, exactly like another VS Code window.

const require = createRequire(import.meta.url);
const compiled = path.resolve(process.env.LIMCODE_TEST_EXTENSION_ROOT ?? 'dist/extension');
const { RuntimeDiagnosticMetrics } = require(path.join(compiled, 'backend/reliableKernel/runtimeDiagnosticMetrics.js'));
const sqlitePath = require.resolve('better-sqlite3');
const Database = require(sqlitePath);
const posixOnly = process.platform === 'win32' ? 'Windows uses LockFileEx, which is not released by closing another handle' : false;

const WORKER_SOURCE = `
const { parentPort, workerData } = require('node:worker_threads');
const Database = require(workerData.sqlitePath);
const db = new Database(workerData.file);
db.pragma('busy_timeout = 0');
const value = (id) => db.prepare('SELECT substr(v, 1, 2) AS v FROM t WHERE id = ?').get(id).v;
parentPort.on('message', ({ id, command, rowId }) => {
  try {
    let result = null;
    if (command === 'begin-write') { db.exec('BEGIN IMMEDIATE'); db.prepare("INSERT INTO t (v) VALUES ('A')").run(); }
    else if (command === 'begin-read') { db.exec('BEGIN'); result = value(rowId); }
    else if (command === 'read') result = value(rowId);
    else if (command === 'commit') db.exec('COMMIT');
    else if (command === 'close') db.close();
    parentPort.postMessage({ id, ok: true, result });
  } catch (error) {
    parentPort.postMessage({ id, ok: false, error: String(error.code ?? error.message) });
  }
});`;

const PEER_SOURCE = `
const Database = require(process.argv[2]);
const db = new Database(process.argv[1]);
db.pragma('busy_timeout = 0');
let buffer = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (chunk) => {
  buffer += chunk;
  for (let index = buffer.indexOf('\\n'); index >= 0; index = buffer.indexOf('\\n')) {
    const command = buffer.slice(0, index);
    buffer = buffer.slice(index + 1);
    let reply;
    try {
      if (command === 'write') {
        db.exec('BEGIN IMMEDIATE');
        db.prepare("INSERT INTO t (v) VALUES ('B')").run();
        db.exec('COMMIT');
        reply = 'ok';
      } else if (command.startsWith('set ')) {
        db.prepare("UPDATE t SET v = ? || substr(v, 3)").run(command.slice(4));
        reply = 'ok';
      } else if (command === 'truncate') {
        reply = JSON.stringify(db.pragma('wal_checkpoint(TRUNCATE)')[0]);
      } else if (command === 'quit') {
        db.close();
        process.stdout.write('bye\\n');
        process.exit(0);
      }
    } catch (error) {
      try { db.exec('ROLLBACK'); } catch {}
      reply = 'err ' + (error.code ?? error.message);
    }
    process.stdout.write(reply + '\\n');
  }
});
process.stdout.write('ready\\n');`;

async function fixture(run) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'limcode-diagnostic-sqlite-locks-'));
  const file = path.join(directory, 'limcode.sqlite');
  const setup = new Database(file);
  setup.pragma('journal_mode = WAL');
  setup.exec('CREATE TABLE t (id INTEGER PRIMARY KEY, v TEXT NOT NULL)');
  const padding = 'x'.repeat(3_000);
  for (let id = 1; id <= 4; id += 1) setup.prepare('INSERT INTO t (id, v) VALUES (?, ?)').run(id, `v0${padding}`);
  setup.pragma('wal_checkpoint(TRUNCATE)');
  setup.prepare("UPDATE t SET v = 'v1' || substr(v, 3)").run();

  const worker = new Worker(WORKER_SOURCE, { eval: true, workerData: { file, sqlitePath } });
  let nextId = 1;
  const pending = new Map();
  worker.on('message', (message) => {
    const waiter = pending.get(message.id);
    pending.delete(message.id);
    if (message.ok) waiter?.resolve(message.result);
    else waiter?.reject(new Error(message.error));
  });
  const inProcess = (command, rowId) => new Promise((resolve, reject) => {
    const id = nextId++;
    pending.set(id, { resolve, reject });
    worker.postMessage({ id, command, rowId });
  });

  const peer = childProcess.spawn(process.execPath, ['-e', PEER_SOURCE, file, sqlitePath], { stdio: ['pipe', 'pipe', 'inherit'] });
  const lines = [];
  let wake;
  let buffer = '';
  peer.stdout.setEncoding('utf8');
  peer.stdout.on('data', (chunk) => {
    buffer += chunk;
    for (let index = buffer.indexOf('\n'); index >= 0; index = buffer.indexOf('\n')) {
      lines.push(buffer.slice(0, index));
      buffer = buffer.slice(index + 1);
    }
    wake?.();
  });
  const nextLine = async () => {
    while (lines.length === 0) await new Promise((resolve) => { wake = resolve; });
    return lines.shift();
  };
  const otherProcess = async (command) => {
    peer.stdin.write(`${command}\n`);
    return nextLine();
  };
  assert.equal(await nextLine(), 'ready');

  const metrics = new RuntimeDiagnosticMetrics({ observe() {}, aggregate() {} }, { paths: { databasePath: file } }, 'lock-test-host');
  try {
    await run({ file, inProcess, otherProcess, metrics, setup });
  } finally {
    await metrics.close();
    if (peer.exitCode === null) await otherProcess('quit').catch(() => undefined);
    await worker.terminate();
    setup.close();
    await fs.rm(directory, { recursive: true, force: true });
  }
}

test('WAL 采样不释放本进程持有的 SQLite 写锁：另一进程仍然得到 SQLITE_BUSY，且无写入丢失', { skip: posixOnly }, async () => {
  await fixture(async ({ file, inProcess, otherProcess, metrics }) => {
    await inProcess('begin-write');
    assert.match(await otherProcess('write'), /^err SQLITE_BUSY/, 'baseline: the writer lock is held');
    const sample = await metrics.sampleWal();
    assert.ok(sample.walBytes > 0);
    assert.match(await otherProcess('write'), /^err SQLITE_BUSY/, 'sampling must not release the in-process writer lock');
    await inProcess('commit');
    assert.equal(await otherProcess('write'), 'ok');
    await inProcess('close');
    const check = new Database(file, { readonly: true });
    try {
      assert.deepEqual(check.prepare("SELECT v FROM t WHERE v IN ('A', 'B') ORDER BY id").all().map((row) => row.v), ['A', 'B']);
      assert.equal(check.pragma('integrity_check', { simple: true }), 'ok');
    } finally { check.close(); }
  });
});

test('WAL 采样不释放本进程的读标记：同一读事务在其它进程写入并 checkpoint 后仍看到同一快照', { skip: posixOnly }, async () => {
  await fixture(async ({ inProcess, otherProcess, metrics }) => {
    assert.equal(await inProcess('begin-read', 1), 'v1');
    await metrics.sampleWal();
    assert.equal(await otherProcess('set v2'), 'ok');
    const checkpoint = JSON.parse(await otherProcess('truncate'));
    assert.equal(checkpoint.busy, 1, 'a live reader mark must block a TRUNCATE checkpoint');
    assert.equal(await otherProcess('set v3'), 'ok');
    assert.equal(await inProcess('read', 3), 'v1', 'the open read transaction keeps its snapshot');
    await inProcess('commit');
    assert.equal(await inProcess('read', 3), 'v3');
  });
});

const python = childProcess.spawnSync('python3', ['-c', 'import fcntl'], { stdio: 'ignore' });
test('WAL 采样不释放本进程在 -shm 上的 DMS 共享锁', { skip: posixOnly || (python.status !== 0 && 'python3 with fcntl is required to probe POSIX locks') }, async () => {
  await fixture(async ({ file, metrics }) => {
    // The idle setup connection in this process holds the DMS byte (offset 128) in shared mode. If
    // another process could take it exclusively, a newly opening Host would reinitialize the live -shm.
    const probe = () => childProcess.spawnSync('python3', ['-c', `
import fcntl, os, struct, sys
fd = os.open(sys.argv[1], os.O_RDWR)
try:
    fcntl.fcntl(fd, fcntl.F_SETLK, struct.pack('hhqqixxxx', fcntl.F_WRLCK, 0, 128, 1, 0))
    print('acquired')
except OSError:
    print('refused')
`, `${file}-shm`], { encoding: 'utf8' }).stdout.trim();
    assert.equal(probe(), 'refused', 'baseline: DMS is shared-locked by this process');
    await metrics.sampleWal();
    assert.equal(probe(), 'refused', 'sampling must not release the DMS lock');
  });
});
