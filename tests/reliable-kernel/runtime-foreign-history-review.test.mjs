// Foreign history, second round: released archive names, classification by SQLite result code, copy
// failures and a container that goes away, the cached size of failed roots, the read-only view's copy
// that must keep its files' state, reads that never follow a link, open a FIFO or touch a file of a
// database this process holds (POSIX fcntl locks: probed from another process), and one test per
// guard that earlier tests left unexercised. Runs against the compiled extension.
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import fs from 'node:fs/promises';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {
  compiled, createFixture, createLimCodeTarget, Database, initialize, kernelFile, openRuntime, RootAuthority
} from './runtime-data-root-relocation-fixture.mjs';

const require = createRequire(import.meta.url);
const fsp = require('node:fs/promises');
const fsSync = require('node:fs');
const foreign = kernelFile('runtimeForeignHistory.js');
const { openRuntimeDataSetHistory } = kernelFile('runtimeDataSetHistory.js');
const { writeRuntimeDataSetMergeLedgerRecord } = kernelFile('runtimeDataSetMergeLedger.js');
const { withRuntimeClaimAtPath } = kernelFile('runtimeHostControl.js');
const { configureWriterConnection } = kernelFile('databaseSchema.js');
const { ROOT_BINDING_PENDING_FILE } = kernelFile('contracts.js');
const { RETIRED_EPOCH_3_TO_4_JOURNAL_FILE, RUNTIME_EPOCH_MIGRATION_JOURNAL_FILE } = kernelFile('runtimeEpochMigration.js');
const { CUTOVER_JOURNAL_FILE, CUTOVER_REQUEST_FILE } = kernelFile('physicalCutover.js');
const { archiveCurrentRuntimeRootForReset } = require(path.join(
  compiled, 'backend/application/reliableKernel/VscodeReliableKernelCutoverCoordinator.js'
));
const NOW = '2026-09-27T00:00:00.000Z';
const POSIX = process.platform !== 'win32';
const PYTHON = POSIX && spawnSync('python3', ['-c', 'import fcntl'], { stdio: 'ignore' }).status === 0;

const control = (root) => path.join(root, '.limcode-runtime');
const active = (root) => path.join(control(root), 'active');
const pointerOf = (root) => path.join(control(root), 'root-binding.json');
const databaseOf = (root) => path.join(active(root), 'limcode.sqlite');
const epochOf = (root) => path.join(active(root), 'runtime-kernel-epoch.json');
const copiedName = (home, index) => `${home}.limcode-copied-2026-09-0${index}T01-02-03-004Z-${String(index).repeat(8)}`;
const entryAt = (report, containerPath) => report.entries.find((entry) => entry.location.containerPath === containerPath);
const delay = (ms) => new Promise((resolve) => { setTimeout(resolve, ms); });

/** `home` (empty, or a LimCode directory with `live`) and a complete LimCode directory elsewhere to copy beside it. */
async function setup(t, name, { live = false } = {}) {
  const directory = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), `limcode-foreign-review-${name}-`)));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const home = path.join(directory, 'home');
  let current;
  if (live) current = await createLimCodeTarget(home);
  else await fs.mkdir(home);
  const elsewhere = path.join(directory, 'elsewhere');
  const source = await createLimCodeTarget(elsewhere);
  return {
    directory, home, current, elsewhere, source,
    async copy(index = 1, from = elsewhere) {
      const copied = copiedName(home, index);
      await fs.cp(from, copied, { recursive: true });
      return copied;
    }
  };
}

async function setEpoch(pointerFile, epochFile, epoch) {
  for (const file of [pointerFile, epochFile]) {
    await fs.writeFile(file, JSON.stringify({ ...JSON.parse(await fs.readFile(file, 'utf8')), runtimeKernelEpoch: epoch }));
  }
}

async function exists(file) {
  try { await fs.lstat(file); return true; } catch (error) { if (error.code === 'ENOENT') return false; throw error; }
}

/** Records the sources of every node:fs copyFile until stopped. */
function spyCopies(onCopied) {
  const copyFile = fsp.copyFile;
  const sources = [];
  fsp.copyFile = async function (from, ...rest) {
    sources.push(path.resolve(String(from)));
    const result = await copyFile.call(this, from, ...rest);
    await onCopied?.(path.resolve(String(from)));
    return result;
  };
  return { sources, stop() { fsp.copyFile = copyFile; } };
}

/** Records every path node:fs/promises opens until stopped. */
function spyOpens() {
  const open = fsp.open;
  const paths = [];
  fsp.open = function (file, ...rest) {
    paths.push(path.resolve(String(file)));
    return open.call(this, file, ...rest);
  };
  return { paths, stop() { fsp.open = open; } };
}

/** Runs `swap` once, right before node:fs/promises opens `file`: the file changes between its lstat and its open. */
function swapBeforeOpen(file, swap) {
  const open = fsp.open;
  let done = false;
  fsp.open = async function (target, ...rest) {
    if (!done && path.resolve(String(target)) === file) {
      done = true;
      await swap();
    }
    return open.call(this, target, ...rest);
  };
  return () => { fsp.open = open; };
}

/** Were a FIFO ever opened for reading, a writer releases it after 5 s: the caller's timing assertion fails, nothing hangs. */
function releaseFifosAfter(files, started = Date.now()) {
  const timer = setInterval(() => {
    if (Date.now() - started < 5000) return;
    for (const file of files) {
      try { fsSync.closeSync(fsSync.openSync(file, fsSync.constants.O_WRONLY | fsSync.constants.O_NONBLOCK)); } catch { /* no reader waiting */ }
    }
  }, 200);
  return { started, stop() { clearInterval(timer); } };
}

/** 'held' while another process cannot write-lock SQLite's SHARED byte range of `file` (POSIX fcntl). */
function sharedLock(file) {
  return execFileSync('python3', ['-c', `
import fcntl, os, sys
fd = os.open(sys.argv[1], os.O_RDWR)
try:
    fcntl.lockf(fd, fcntl.LOCK_EX | fcntl.LOCK_NB, 510, 0x40000002, 0)
    fcntl.lockf(fd, fcntl.LOCK_UN, 510, 0x40000002, 0)
    print('free')
except OSError:
    print('held')
`, file], { encoding: 'utf8' }).trim();
}

/** This process opens the Runtime of `home` (its worker holds the database's locks) beside a verified copied directory. */
async function lockSetup(t, name) {
  const context = await setup(t, name, { live: true });
  const copied = await context.copy(1);
  const runtime = await openRuntime(context.current);
  t.after(() => runtime.close().catch(() => undefined));
  const liveDb = context.current.binding.paths.databasePath;
  assert.equal(sharedLock(liveDb), 'held', '本进程打开的当前库持有 SHARED 锁');
  return { ...context, copied, liveDb };
}

test('已发布版本自动归档的名字 <时间>-epoch-N-to-M-<id8> 也被发现；第 3/4 代的归档与拷来目录如实说明不能打开的原因，不承诺“在原位置升级”；第 1/2 代说明不受支持', async (t) => {
  const fixture = await createFixture(t);
  const alpha = fixture.alpha;
  const authority = new RootAuthority(() => alpha.binding.paths.dataRootPath, undefined, () => fixture.root);
  const archived = await archiveCurrentRuntimeRootForReset(authority, alpha.scopeRoot);
  await initialize(alpha.scopeRoot, alpha.id);
  const name = path.basename(archived.backupPath);
  const released = path.join(path.dirname(archived.backupPath), `${name.slice(0, 19)}-epoch-3-to-4-${name.slice(-8)}`);
  await fs.rename(archived.backupPath, released);

  const found = await foreign.discoverForeignRuntimeHistory({ configurationRootPath: fixture.root });
  assert.ok(found.some((entry) => entry.location.containerPath === released && entry.name === path.basename(released)),
    `发现已发布命名的归档：${JSON.stringify(found.map((entry) => entry.location.containerName))}`);
  const verified = entryAt(await foreign.inspectForeignRuntimeHistory({ configurationRootPath: fixture.root }), released);
  assert.equal(verified?.status, 'verified', verified?.reason);

  // Inside a copied directory the same name is recognized too.
  const home = path.join(fixture.base, 'home');
  await fs.mkdir(home);
  await fs.cp(fixture.root, copiedName(home, 1), { recursive: true });
  const inCopied = await foreign.discoverForeignRuntimeHistory({ configurationRootPath: home });
  assert.ok(inCopied.some((entry) => entry.archiveName === path.basename(released)), JSON.stringify(inCopied.map((entry) => entry.location.dataRootRelativePath)));

  await setEpoch(path.join(released, 'root-binding.json'), path.join(released, 'active', 'runtime-kernel-epoch.json'), 3);
  const old = entryAt(await foreign.inspectForeignRuntimeHistory({ configurationRootPath: fixture.root }), released);
  assert.equal(old?.status, 'failed');
  assert.equal(old.code, 'foreign-history-epoch-not-current');
  assert.match(old.reason, /已发布旧格式（第 3 代）的归档.*位置在归档时已经交给了新建的库.*当前版本不能打开它。它原样保留，不会被删除。/);
  assert.doesNotMatch(old.reason, /只能在原位置由 LimCode 备份后升级|不在别处升级它/);
  assert.equal(typeof old.size?.bytes, 'string');

  const copied = copiedName(home, 2);
  await fs.cp(path.join(fixture.base, 'old-home'), copied, { recursive: true });
  await setEpoch(pointerOf(copied), epochOf(copied), 4);
  const copiedOld = (await foreign.inspectForeignRuntimeHistory({ configurationRootPath: home })).entries
    .find((entry) => entry.location.containerPath === copied && entry.location.dataRootRelativePath === '.limcode-runtime/active');
  assert.equal(copiedOld?.code, 'foreign-history-epoch-not-current');
  assert.match(copiedOld.reason, /已发布的旧格式（第 4 代）.*不升级从别处拷来的目录.*原样保留，不会被删除。/);

  await setEpoch(path.join(released, 'root-binding.json'), path.join(released, 'active', 'runtime-kernel-epoch.json'), 2);
  const unsupported = entryAt(await foreign.inspectForeignRuntimeHistory({ configurationRootPath: fixture.root }), released);
  assert.equal(unsupported?.code, 'foreign-history-epoch-not-current');
  assert.match(unsupported.reason, /不受支持的旧格式（第 2 代），当前版本不能读取，也不能升级它/);
});

test('按 SQLite 结果码分类：页损坏（SQLITE_CORRUPT，“database disk image is malformed”）与不是数据库（SQLITE_NOTADB）记为未通过并按文件状态缓存，再次列出不再复制整库', async (t) => {
  const context = await setup(t, 'corrupt');
  const corrupt = await context.copy(1);
  const database = new Database(databaseOf(corrupt));
  let rootPage; let pageSize;
  try {
    database.pragma('wal_checkpoint(TRUNCATE)');
    pageSize = Number(database.pragma('page_size', { simple: true }));
    rootPage = Number(database.prepare("SELECT rootpage FROM sqlite_master WHERE name = 'root_binding'").pluck().get());
    database.pragma('journal_mode = DELETE');
  } finally { database.close(); }
  const handle = await fs.open(databaseOf(corrupt), 'r+');
  try { await handle.write(Buffer.from([0xff]), 0, 1, (rootPage - 1) * pageSize); } finally { await handle.close(); }
  const notADatabase = await context.copy(2);
  await fs.rm(`${databaseOf(notADatabase)}-wal`, { force: true });
  await fs.rm(`${databaseOf(notADatabase)}-shm`, { force: true });
  await fs.writeFile(databaseOf(notADatabase), Buffer.alloc(8192, 0x5a));

  const first = await foreign.inspectForeignRuntimeHistory({ configurationRootPath: context.home });
  for (const copied of [corrupt, notADatabase]) {
    const entry = entryAt(first, copied);
    assert.equal(entry?.status, 'failed', JSON.stringify(entry));
    assert.equal(entry.code, 'foreign-history-audit-failed');
    assert.ok(await exists(path.join(context.home, '.limcode-runtime-merges', 'foreign', `${entry.id.replace(/:/g, '-')}.json`)), '未通过按文件状态缓存');
  }
  assert.match(entryAt(first, corrupt).reason, /malformed/);
  const spy = spyCopies();
  let again;
  try { again = await foreign.inspectForeignRuntimeHistory({ configurationRootPath: context.home }); }
  finally { spy.stop(); }
  assert.deepEqual(spy.sources.filter((source) => source.startsWith(corrupt) || source.startsWith(notADatabase)), [], '缓存命中，不再复制');
  assert.equal(entryAt(again, corrupt).status, 'failed');
});

test('复制失败一律暂时无法核验：临时目录不存在（ENOENT）时不记为未通过、不入缓存，恢复后同一个库核验通过；核验中途整个目录被移走时说明它已不在', async (t) => {
  const context = await setup(t, 'copy-failed');
  const copied = await context.copy(1);
  const temporary = process.env.TMPDIR;
  process.env.TMPDIR = path.join(context.directory, 'no-such-temp');
  let entry;
  try { entry = entryAt(await foreign.inspectForeignRuntimeHistory({ configurationRootPath: context.home }), copied); }
  finally { if (temporary === undefined) delete process.env.TMPDIR; else process.env.TMPDIR = temporary; }
  assert.equal(entry?.status, 'unavailable', JSON.stringify(entry));
  assert.equal(entry.code, 'foreign-history-copy-failed');
  assert.match(entry.reason, /复制数据库到私有临时目录失败.*稍后再试/);
  assert.equal(await exists(path.join(context.home, '.limcode-runtime-merges', 'foreign', `${entry.id.replace(/:/g, '-')}.json`)), false, '不入缓存');
  assert.equal(entryAt(await foreign.inspectForeignRuntimeHistory({ configurationRootPath: context.home }), copied)?.status, 'verified');

  const vanishing = await context.copy(2);
  const copyFile = fsp.copyFile;
  fsp.copyFile = async function (from, ...rest) {
    if (path.resolve(String(from)) === databaseOf(vanishing)) await fs.rm(vanishing, { recursive: true, force: true });
    return copyFile.call(this, from, ...rest);
  };
  let gone;
  try { gone = entryAt(await foreign.inspectForeignRuntimeHistory({ configurationRootPath: context.home }), vanishing); }
  finally { fsp.copyFile = copyFile; }
  assert.equal(gone?.status, 'unavailable', JSON.stringify(gone));
  assert.equal(gone.code, 'foreign-history-gone');
  assert.match(gone.reason, /已经被移走或删除/);
  assert.doesNotMatch(gone.reason, /符号链接/);
});

test('未通过条目的大小按文件状态缓存：第二次列出只看几个文件的状态，不再遍历整棵树；树根有变化时重新统计', async (t) => {
  const context = await setup(t, 'size');
  const copied = await context.copy(1);
  await setEpoch(pointerOf(copied), epochOf(copied), 4);
  const bulk = path.join(active(copied), 'cas', 'bulk');
  await fs.mkdir(bulk, { recursive: true });
  for (let index = 0; index < 2000; index += 1) await fs.writeFile(path.join(bulk, String(index)), 'x');
  const first = entryAt(await foreign.inspectForeignRuntimeHistory({ configurationRootPath: context.home }), copied);
  assert.equal(first?.status, 'failed');
  assert.ok(first.size.fileCount > 2000, JSON.stringify(first.size));

  const lstat = fsp.lstat;
  let inside = 0;
  fsp.lstat = function (file, ...rest) {
    if (path.resolve(String(file)).startsWith(copied)) inside += 1;
    return lstat.call(this, file, ...rest);
  };
  let second;
  try { second = entryAt(await foreign.inspectForeignRuntimeHistory({ configurationRootPath: context.home }), copied); }
  finally { fsp.lstat = lstat; }
  assert.deepEqual(second.size, first.size);
  assert.ok(inside < 100, `第二次列出不再遍历（lstat ${inside} 次）`);

  await fs.writeFile(path.join(control(copied), 'added.txt'), 'y');
  const third = entryAt(await foreign.inspectForeignRuntimeHistory({ configurationRootPath: context.home }), copied);
  assert.equal(third.size.fileCount, first.size.fileCount + 1, '树根变化后重新统计');
});

test('只读查看复用核验的前后状态比较：复制数据库和复制 WAL 之间源库做了检查点、WAL 被删，查看会重新复制，读到的是检查点之后的完整内容', async (t) => {
  const context = await setup(t, 'view-race');
  const writer = new Database(context.source.binding.paths.databasePath);
  configureWriterConnection(writer);
  writer.pragma('wal_autocheckpoint = 0');
  writer.prepare('INSERT INTO conversation VALUES (?, ?, ?, ?, ?)').run('wal-only', 'WAL 里的对话', 'active', NOW, NOW);
  const copied = await context.copy(1);
  writer.close();
  await fs.rm(`${databaseOf(copied)}-shm`, { force: true });
  assert.ok((await fs.stat(`${databaseOf(copied)}-wal`)).size > 0, '拷来目录带着未检查点的 WAL');
  const paths = { globalStoragePath: context.home };
  const entry = entryAt(await foreign.inspectForeignRuntimeHistory({ configurationRootPath: context.home }), copied);
  assert.equal(entry?.status, 'verified', entry?.reason);
  const root = await foreign.locateForeignRuntimeRoot(context.home, entry.location);

  let raced = false;
  const spy = spyCopies(async (from) => {
    if (raced || from !== databaseOf(copied)) return;
    raced = true;
    // Between the database copy and the WAL copy: a checkpoint moves the WAL into the database and removes it.
    const other = new Database(databaseOf(copied));
    try { other.pragma('wal_checkpoint(TRUNCATE)'); } finally { other.close(); }
    await fs.rm(`${databaseOf(copied)}-wal`, { force: true });
  });
  let listed;
  try {
    const reader = await openRuntimeDataSetHistory(paths, root);
    try { listed = (await reader.listConversations()).items.map((item) => item.id); }
    finally { await reader.close(); }
  } finally { spy.stop(); }
  assert.ok(raced);
  assert.ok(spy.sources.filter((source) => source === databaseOf(copied)).length >= 2, '文件状态变了，重新复制');
  assert.ok(listed.includes('wal-only'), `没有静默丢掉 WAL 里已提交的对话：${JSON.stringify(listed)}`);
});

test('外来库里正在进行的根切换、升级与迁移（每一种进行中文件）都挡住核验', async (t) => {
  const context = await setup(t, 'in-progress');
  const files = [ROOT_BINDING_PENDING_FILE, RUNTIME_EPOCH_MIGRATION_JOURNAL_FILE, RETIRED_EPOCH_3_TO_4_JOURNAL_FILE, CUTOVER_REQUEST_FILE, CUTOVER_JOURNAL_FILE];
  const copies = [];
  for (const [index, name] of files.entries()) {
    const copied = await context.copy(index + 1);
    await fs.writeFile(path.join(control(copied), name), '{}');
    copies.push([name, copied]);
  }
  const report = await foreign.inspectForeignRuntimeHistory({ configurationRootPath: context.home });
  for (const [name, copied] of copies) {
    const entry = entryAt(report, copied);
    assert.equal(entry?.status, 'failed', name);
    assert.equal(entry.code, 'foreign-history-unfinished-operation', name);
    assert.ok(entry.reason.includes(name), entry.reason);
  }
});

test('拷来目录自己的迁移记录处在撤销中（undoing）时同样挡住核验', async (t) => {
  const context = await setup(t, 'undoing');
  const copied = await context.copy(1);
  await fs.writeFile(path.join(copied, '.limcode-data-root-relocation.json'), JSON.stringify({ kind: 'limcode-data-root-relocation', state: 'undoing' }));
  const entry = entryAt(await foreign.inspectForeignRuntimeHistory({ configurationRootPath: context.home }), copied);
  assert.equal(entry?.status, 'failed');
  assert.equal(entry.code, 'foreign-history-unfinished-relocation');
});

test('归档的合并记录在它所属的数据目录（当前配置根）里：那里正在提交、涉及这份归档的合并挡住核验', async (t) => {
  const fixture = await createFixture(t);
  const authority = new RootAuthority(() => fixture.alpha.binding.paths.dataRootPath, undefined, () => fixture.root);
  const archived = await archiveCurrentRuntimeRootForReset(authority, fixture.alpha.scopeRoot);
  await initialize(fixture.alpha.scopeRoot, fixture.alpha.id);
  await writeRuntimeDataSetMergeLedgerRecord(fixture.paths, {
    candidateId: 'workspace:other', state: 'committing', commitId: 'commit-1',
    target: { dataSetId: fixture.alpha.binding.dataSetId, rootInstanceId: fixture.alpha.binding.rootInstanceId },
    source: { dataSetId: 'other', rootInstanceId: 'other', rootGeneration: 1, pointerRevision: 1, contentDigest: 'x' }
  });
  const entry = entryAt(await foreign.inspectForeignRuntimeHistory({ configurationRootPath: fixture.root }), archived.backupPath);
  assert.equal(entry?.status, 'failed', JSON.stringify(entry));
  assert.equal(entry.code, 'foreign-history-unfinished-merge');
});

test('外来库的互斥声明在当前配置根下：另一处持有同一外来库的声明时核验等它释放，释放后照常核验，声明用完即删', { timeout: 60000 }, async (t) => {
  const context = await setup(t, 'claim');
  const copied = await context.copy(1);
  const discovered = (await foreign.discoverForeignRuntimeHistory({ configurationRootPath: context.home })).find((entry) => entry.location.containerPath === copied);
  const claims = path.join(context.home, '.limcode-runtime-merges', 'foreign-claims');
  let acquired;
  const holding = new Promise((resolve) => { acquired = resolve; });
  let release;
  const released = new Promise((resolve) => { release = resolve; });
  const holder = withRuntimeClaimAtPath(path.join(claims, discovered.id.replace(/:/g, '-')), pointerOf(copied), async () => { acquired(); await released; });
  await holding;
  let settled = false;
  let inspection;
  try {
    inspection = foreign.inspectForeignRuntimeHistory({ configurationRootPath: context.home }).finally(() => { settled = true; });
    await Promise.race([inspection.catch(() => undefined), delay(2500)]);
    assert.equal(settled, false, '声明被持有时核验在等待');
  } finally {
    release();
    await holder;
  }
  const entry = entryAt(await inspection, copied);
  assert.equal(entry?.status, 'verified', entry?.reason);
  assert.deepEqual(await fs.readdir(claims), [], '声明用完即释放');
});

test('当前库的旧拷贝要求 dataSetId 与 rootInstanceId 都相同：同一 dataSetId 的另一个根实例不算旧拷贝', async (t) => {
  const context = await setup(t, 'same-data-set', { live: true });
  const snapshot = path.join(context.directory, 'snapshot');
  await fs.cp(context.home, snapshot, { recursive: true });
  const same = await context.copy(1, snapshot);
  const other = await context.copy(2, snapshot);
  const instance = 'another-root-instance';
  for (const file of [pointerOf(other), epochOf(other)]) {
    await fs.writeFile(file, JSON.stringify({ ...JSON.parse(await fs.readFile(file, 'utf8')), rootInstanceId: instance }));
  }
  const database = new Database(databaseOf(other));
  try { database.prepare('UPDATE root_binding SET root_instance_id = ? WHERE singleton = 1').run(instance); }
  finally { database.close(); }
  const report = await foreign.inspectForeignRuntimeHistory({ configurationRootPath: context.home });
  assert.equal(entryAt(report, same)?.status, 'verified', entryAt(report, same)?.reason);
  assert.deepEqual(entryAt(report, same).sameAsLocal, { candidateId: 'default', selected: true });
  const changed = entryAt(report, other);
  assert.equal(changed?.status, 'verified', changed?.reason);
  assert.equal(changed.dataSetId, context.current.binding.dataSetId);
  assert.equal(changed.rootInstanceId, instance);
  assert.equal(changed.sameAsLocal, undefined, '另一个根实例不是当前库的旧拷贝');
});

test('host-liveness 里名为 *.json 的 FIFO：不打开它，核验不挂起，记为未通过；合并账本里的 FIFO 不是记录，照样跳过', { skip: !POSIX }, async (t) => {
  const context = await setup(t, 'fifo');
  const copied = await context.copy(1);
  const liveness = path.join(active(copied), 'host-liveness');
  await fs.mkdir(liveness, { recursive: true });
  const fifo = path.join(liveness, 'stuck.json');
  execFileSync('mkfifo', [fifo]);
  const ledgerCopy = await context.copy(2);
  const records = path.join(ledgerCopy, '.limcode-runtime-merges', 'records');
  await fs.mkdir(records, { recursive: true });
  execFileSync('mkfifo', [path.join(records, 'stuck.json')]);
  const started = Date.now();
  // Were a FIFO ever opened for reading, a writer released it after the deadline (the test fails, never hangs).
  const watchdog = setInterval(() => {
    if (Date.now() - started < 5000) return;
    for (const file of [fifo, path.join(records, 'stuck.json')]) {
      try { fsSync.closeSync(fsSync.openSync(file, fsSync.constants.O_WRONLY | fsSync.constants.O_NONBLOCK)); } catch { /* no reader waiting */ }
    }
  }, 200);
  let report;
  try { report = await foreign.inspectForeignRuntimeHistory({ configurationRootPath: context.home }); }
  finally { clearInterval(watchdog); }
  assert.ok(Date.now() - started < 5000, '没有在 FIFO 上等待');
  const entry = entryAt(report, copied);
  assert.equal(entry?.status, 'failed', JSON.stringify(entry));
  assert.equal(entry.code, 'foreign-history-host-record');
  assert.match(entry.reason, /stuck\.json 不是普通文件/);
  assert.equal(entryAt(report, ledgerCopy)?.status, 'verified', entryAt(report, ledgerCopy)?.reason);
  assert.deepEqual(await fs.readdir(path.join(context.home, '.limcode-runtime-merges', 'foreign-claims')), [], '声明已释放');
});

test('POSIX 锁：host-liveness 里指向当前库的符号链接不被打开，核验记为未通过，本进程当前库的锁仍然持有', { skip: !PYTHON }, async (t) => {
  const context = await lockSetup(t, 'lock-symlink');
  const liveness = path.join(active(context.copied), 'host-liveness');
  await fs.mkdir(liveness, { recursive: true });
  await fs.symlink(context.liveDb, path.join(liveness, 'evil.json'));
  const entry = entryAt(await foreign.inspectForeignRuntimeHistory({ configurationRootPath: context.home }), context.copied);
  assert.equal(entry?.status, 'failed', JSON.stringify(entry));
  assert.equal(entry.code, 'foreign-history-host-record');
  assert.equal(sharedLock(context.liveDb), 'held', '锁仍然持有');
});

test('POSIX 锁：host-liveness 记录与合并账本记录是当前库的硬链接时都不被打开，本进程当前库的锁仍然持有', { skip: !PYTHON }, async (t) => {
  const context = await lockSetup(t, 'lock-hardlink');
  const liveness = path.join(active(context.copied), 'host-liveness');
  await fs.mkdir(liveness, { recursive: true });
  const record = path.join(liveness, 'evil.json');
  await fs.link(context.liveDb, record);
  const records = path.join(context.copied, '.limcode-runtime-merges', 'records');
  const ledgerRecord = path.join(records, 'evil.json');
  const opened = spyOpens();
  let entry; let skipped;
  try {
    entry = entryAt(await foreign.inspectForeignRuntimeHistory({ configurationRootPath: context.home }), context.copied);
    assert.equal(sharedLock(context.liveDb), 'held', '锁仍然持有');
    await fs.rm(record);
    await fs.mkdir(records, { recursive: true });
    await fs.link(context.liveDb, ledgerRecord);
    skipped = entryAt(await foreign.inspectForeignRuntimeHistory({ configurationRootPath: context.home }), context.copied);
  } finally { opened.stop(); }
  assert.equal(entry?.status, 'failed', JSON.stringify(entry));
  assert.equal(entry.code, 'foreign-history-open-database');
  assert.equal(skipped?.status, 'verified', skipped?.reason);
  assert.equal(sharedLock(context.liveDb), 'held', '锁仍然持有');
  assert.deepEqual(opened.paths.filter((file) => file === record || file === ledgerRecord), [], '连描述符都没有打开过');
});

test('POSIX 锁：启动发现时 RootBinding 指针是当前库的硬链接，不打开它，锁仍然持有；核验同样拒绝', { skip: !PYTHON }, async (t) => {
  const context = await lockSetup(t, 'lock-pointer');
  await fs.rm(pointerOf(context.copied));
  await fs.link(context.liveDb, pointerOf(context.copied));
  const found = await foreign.discoverForeignRuntimeHistory({ configurationRootPath: context.home });
  assert.ok(found.some((entry) => entry.location.containerPath === context.copied));
  assert.equal(sharedLock(context.liveDb), 'held', '发现阶段之后锁仍然持有');
  const entry = entryAt(await foreign.inspectForeignRuntimeHistory({ configurationRootPath: context.home }), context.copied);
  assert.equal(entry?.code, 'foreign-history-open-database');
  assert.equal(sharedLock(context.liveDb), 'held', '核验之后锁仍然持有');
});

test('POSIX 锁：列出之后外来库的数据库、正文被换成当前库的硬链接，只读查看在复制和读取前重新检查，拒绝且锁仍然持有', { skip: !PYTHON }, async (t) => {
  const context = await lockSetup(t, 'lock-view');
  const paths = { globalStoragePath: context.home };
  const entry = entryAt(await foreign.inspectForeignRuntimeHistory({ configurationRootPath: context.home }), context.copied);
  assert.equal(entry?.status, 'verified', entry?.reason);
  const root = await foreign.locateForeignRuntimeRoot(context.home, entry.location);

  // The body of a message: its content file replaced after the reader opened.
  const reader = await openRuntimeDataSetHistory(paths, root);
  try {
    const files = [];
    const walk = async (directory) => {
      for (const item of await fs.readdir(directory, { withFileTypes: true })) {
        if (item.isDirectory()) await walk(path.join(directory, item.name));
        else if (item.isFile()) files.push(path.join(directory, item.name));
      }
    };
    await walk(path.join(active(context.copied), 'cas'));
    assert.equal(files.length, 1);
    await fs.rm(files[0]);
    await fs.link(context.liveDb, files[0]);
    await assert.rejects(reader.readMessages('conversation_existing_1'), /同一个文件（硬链接）/);
    assert.equal(sharedLock(context.liveDb), 'held', '读取正文被拒绝，锁仍然持有');
  } finally { await reader.close(); }

  await fs.rm(databaseOf(context.copied));
  await fs.link(context.liveDb, databaseOf(context.copied));
  await assert.rejects(openRuntimeDataSetHistory(paths, root), (error) => error.code === 'foreign-history-open-database');
  assert.equal(sharedLock(context.liveDb), 'held', '只读查看被拒绝，锁仍然持有');
});

test('lstat 与打开之间文件被换掉：换成 FIFO 不挂起（O_NONBLOCK），换成符号链接不跟随（O_NOFOLLOW），换成另一个文件视为变化；都不读取', { skip: !POSIX }, async (t) => {
  const context = await setup(t, 'swap');
  const locate = async (copied) => {
    const [found] = (await foreign.discoverForeignRuntimeHistory({ configurationRootPath: context.home }))
      .filter((entry) => entry.location.containerPath === copied);
    return found.location;
  };
  const outcome = async (copied, swap) => {
    const location = await locate(copied);
    const restore = swapBeforeOpen(pointerOf(copied), swap);
    const fifoRelease = releaseFifosAfter([pointerOf(copied)]);
    try {
      await foreign.locateForeignRuntimeRoot(context.home, location);
      return { located: true, ms: Date.now() - fifoRelease.started };
    } catch (error) {
      return { status: error.status, code: error.code, message: error.message, ms: Date.now() - fifoRelease.started };
    } finally { restore(); fifoRelease.stop(); }
  };
  const fifo = await context.copy(1);
  const asFifo = await outcome(fifo, async () => { await fs.rm(pointerOf(fifo)); execFileSync('mkfifo', [pointerOf(fifo)]); });
  assert.ok(asFifo.ms < 5000, `没有在 FIFO 上等待：${JSON.stringify(asFifo)}`);
  assert.equal(asFifo.code, 'foreign-history-changed', JSON.stringify(asFifo));

  const linked = await context.copy(2);
  const elsewherePointer = path.join(context.directory, 'pointer-copy.json');
  await fs.copyFile(pointerOf(linked), elsewherePointer);
  const asLink = await outcome(linked, async () => { await fs.rm(pointerOf(linked)); await fs.symlink(elsewherePointer, pointerOf(linked)); });
  assert.equal(asLink.status, 'failed', JSON.stringify(asLink));
  assert.match(asLink.message, /ELOOP/, '以 O_NOFOLLOW 打开，链接不被跟随');

  const replaced = await context.copy(3);
  const asOther = await outcome(replaced, async () => {
    const other = `${pointerOf(replaced)}.other`;
    await fs.copyFile(pointerOf(replaced), other);
    await fs.rename(other, pointerOf(replaced));
  });
  assert.equal(asOther.code, 'foreign-history-changed', JSON.stringify(asOther));
  assert.equal(asOther.status, 'unavailable');
});

test('POSIX 锁：lstat 之后、打开之前指针被换成当前库的硬链接：打开后按描述符发现是持锁文件，描述符保留不关，锁仍然持有', { skip: !PYTHON }, async (t) => {
  const context = await lockSetup(t, 'lock-race');
  const [found] = (await foreign.discoverForeignRuntimeHistory({ configurationRootPath: context.home }))
    .filter((entry) => entry.location.containerPath === context.copied);
  const restore = swapBeforeOpen(pointerOf(context.copied), async () => {
    await fs.rm(pointerOf(context.copied));
    await fs.link(context.liveDb, pointerOf(context.copied));
  });
  try {
    await assert.rejects(foreign.locateForeignRuntimeRoot(context.home, found.location), (error) => error.code === 'foreign-history-open-database');
  } finally { restore(); }
  assert.equal(sharedLock(context.liveDb), 'held', '锁仍然持有');
});

test('POSIX 锁：本进程打开的数据库不在当前配置根里（按本进程登记的数据库判断）时，外来库里它的硬链接同样不被打开', { skip: !PYTHON }, async (t) => {
  const context = await setup(t, 'lock-registered');
  const copied = await context.copy(1);
  const other = await createLimCodeTarget(path.join(context.directory, 'other'));
  const runtime = await openRuntime(other);
  t.after(() => runtime.close().catch(() => undefined));
  const otherDb = other.binding.paths.databasePath;
  assert.equal(sharedLock(otherDb), 'held');
  await fs.rm(pointerOf(copied));
  await fs.link(otherDb, pointerOf(copied));
  await foreign.discoverForeignRuntimeHistory({ configurationRootPath: context.home });
  const entry = entryAt(await foreign.inspectForeignRuntimeHistory({ configurationRootPath: context.home }), copied);
  assert.equal(entry?.code, 'foreign-history-open-database', JSON.stringify(entry));
  assert.equal(sharedLock(otherDb), 'held', '锁仍然持有');
});

test('POSIX 锁：复制前按每次尝试重新检查数据库文件，定位之后被换成当前库硬链接的数据库不被复制；持锁集合含本进程登记的库，查看本地库时只除去它自己', { skip: !PYTHON }, async (t) => {
  const context = await lockSetup(t, 'lock-copy');
  const held = await foreign.heldDatabaseFiles(context.home);
  const live = await fs.stat(context.liveDb, { bigint: true });
  assert.ok(held.has(`${live.dev}:${live.ino}`));
  assert.equal((await foreign.heldDatabaseFiles(context.home, { except: context.liveDb })).has(`${live.dev}:${live.ino}`), true, '除去的只是配置根里的这一份：本进程登记的仍在');
  const entry = entryAt(await foreign.inspectForeignRuntimeHistory({ configurationRootPath: context.home }), context.copied);
  const root = await foreign.locateForeignRuntimeRoot(context.home, entry.location, held);
  await fs.rm(databaseOf(context.copied));
  await fs.link(context.liveDb, databaseOf(context.copied));
  await assert.rejects(foreign.copyLocatedRuntimeDatabase(root, held), (error) => error.code === 'foreign-history-open-database');
  assert.equal(sharedLock(context.liveDb), 'held', '锁仍然持有');
});

test('只读查看在外来库声明内重新核验：等声明期间 host-liveness 里出现 FIFO，查看按普通文件规则拒绝，不挂起', { skip: !POSIX, timeout: 60000 }, async (t) => {
  const context = await setup(t, 'view-fence');
  const copied = await context.copy(1);
  const liveness = path.join(active(copied), 'host-liveness');
  await fs.mkdir(liveness, { recursive: true });
  const paths = { globalStoragePath: context.home };
  const entry = entryAt(await foreign.inspectForeignRuntimeHistory({ configurationRootPath: context.home }), copied);
  assert.equal(entry?.status, 'verified', entry?.reason);
  const root = await foreign.locateForeignRuntimeRoot(context.home, entry.location);
  const claimPath = path.join(context.home, '.limcode-runtime-merges', 'foreign-claims', entry.id.replace(/:/g, '-'));
  let acquired;
  const holding = new Promise((resolve) => { acquired = resolve; });
  let release;
  const released = new Promise((resolve) => { release = resolve; });
  const holder = withRuntimeClaimAtPath(claimPath, pointerOf(copied), async () => { acquired(); await released; });
  await holding;
  let reached;
  const atFence = new Promise((resolve) => { reached = resolve; });
  const lstat = fsp.lstat;
  fsp.lstat = function (file, ...rest) {
    if (path.resolve(String(file)) === claimPath) reached();
    return lstat.call(this, file, ...rest);
  };
  let opening;
  let first;
  const fifo = path.join(liveness, 'late.json');
  let fifoRelease;
  try {
    opening = openRuntimeDataSetHistory(paths, root).then(async (reader) => { await reader.close(); return 'opened'; }, (error) => error);
    first = await Promise.race([atFence.then(() => 'fence'), opening.then(() => 'settled'), delay(10000).then(() => 'timeout')]);
    fsp.lstat = lstat;
    assert.equal(first, 'fence', '查看在外来库的声明处等待');
    execFileSync('mkfifo', [fifo]);
    fifoRelease = releaseFifosAfter([fifo]);
  } finally {
    fsp.lstat = lstat;
    release();
    await holder;
  }
  let outcome;
  try { outcome = await opening; } finally { fifoRelease.stop(); }
  assert.ok(Date.now() - fifoRelease.started < 5000, '没有在 FIFO 上等待');
  assert.ok(outcome instanceof Error, `查看被拒绝：${String(outcome)}`);
  assert.equal(outcome.code, 'foreign-history-host-record');
});

test('host-liveness 不是目录（普通文件）时无法证明进程已结束：记为未通过，不当作没有记录', async (t) => {
  const context = await setup(t, 'liveness-file');
  const copied = await context.copy(1);
  await fs.rm(path.join(active(copied), 'host-liveness'), { recursive: true, force: true });
  await fs.writeFile(path.join(active(copied), 'host-liveness'), 'not a directory');
  const entry = entryAt(await foreign.inspectForeignRuntimeHistory({ configurationRootPath: context.home }), copied);
  assert.equal(entry?.status, 'failed', JSON.stringify(entry));
  assert.equal(entry.code, 'foreign-history-host-record');
});

test('核验线程遇到暂时性的 SQLite 结果码（SQLITE_CANTOPEN：私有副本在打开前不见了）只是暂时无法核验，不入缓存', async (t) => {
  const context = await setup(t, 'cantopen');
  const copied = await context.copy(1);
  const copyFile = fsp.copyFile;
  fsp.copyFile = async function (from, to, ...rest) {
    const result = await copyFile.call(this, from, to, ...rest);
    if (path.resolve(String(from)) === databaseOf(copied)) await fs.rm(String(to), { force: true });
    return result;
  };
  let entry;
  try { entry = entryAt(await foreign.inspectForeignRuntimeHistory({ configurationRootPath: context.home }), copied); }
  finally { fsp.copyFile = copyFile; }
  assert.equal(entry?.status, 'unavailable', JSON.stringify(entry));
  assert.equal(entry.code, 'foreign-history-audit-unavailable');
  assert.equal(await exists(path.join(context.home, '.limcode-runtime-merges', 'foreign', `${entry.id.replace(/:/g, '-')}.json`)), false, '不入缓存');
});

test('目录在发现之后被移走：核验说明它已不在，而不是“符号链接”或“不完整”；读指针前一刻被移走同样如此', async (t) => {
  const context = await setup(t, 'gone');
  const early = await context.copy(1);
  const late = await context.copy(2);
  const found = await foreign.discoverForeignRuntimeHistory({ configurationRootPath: context.home });
  const locationOf = (copied) => found.find((entry) => entry.location.containerPath === copied).location;
  await fs.rm(early, { recursive: true, force: true });
  await assert.rejects(foreign.locateForeignRuntimeRoot(context.home, locationOf(early)),
    (error) => error.code === 'foreign-history-gone' && error.status === 'unavailable');
  const restore = swapBeforeOpen(pointerOf(late), () => fs.rm(late, { recursive: true, force: true }));
  try {
    await assert.rejects(foreign.locateForeignRuntimeRoot(context.home, locationOf(late)),
      (error) => error.code === 'foreign-history-gone' && /已经被移走或删除/.test(error.message));
  } finally { restore(); }
});

test('读不了的归档目录（没有权限）只是暂时无法核验，写明原因，不说“里面没有历史库”', { skip: !POSIX || process.getuid?.() === 0 }, async (t) => {
  const fixture = await createFixture(t);
  const authority = new RootAuthority(() => fixture.current.binding.paths.dataRootPath, undefined, () => fixture.root);
  const archived = await archiveCurrentRuntimeRootForReset(authority, fixture.current.scopeRoot);
  await initialize(fixture.current.scopeRoot, fixture.current.id);
  const archives = path.dirname(archived.backupPath);
  await fs.chmod(archives, 0o000);
  t.after(() => fs.chmod(archives, 0o755).catch(() => undefined));
  const entry = (await foreign.inspectForeignRuntimeHistory({ configurationRootPath: fixture.root })).entries
    .find((item) => item.location.containerPath === archives);
  await fs.chmod(archives, 0o755);
  assert.equal(entry?.status, 'unavailable', JSON.stringify(entry));
  assert.equal(entry.code, 'foreign-history-no-runtime');
  assert.match(entry.reason, /暂时无法核验.*EACCES/);
});

test('上一个数据目录里的归档：位置必须严格按发现规则（以上一个目录命名、就在它下面），它下面的符号链接不被跟随', async (t) => {
  const fixture = await createFixture(t);
  const authority = new RootAuthority(() => fixture.alpha.binding.paths.dataRootPath, undefined, () => fixture.root);
  const archived = await archiveCurrentRuntimeRootForReset(authority, fixture.alpha.scopeRoot);
  await initialize(fixture.alpha.scopeRoot, fixture.alpha.id);
  const home = path.join(fixture.base, 'new-home');
  await fs.mkdir(home);
  const found = await foreign.discoverForeignRuntimeHistory({ configurationRootPath: home, previousDataRootPath: fixture.root });
  const entry = found.find((item) => item.location.containerPath === archived.backupPath);
  assert.equal(entry?.location.side, 'previous');
  await foreign.locateForeignRuntimeRoot(home, entry.location);
  const rejected = (location) => assert.rejects(foreign.locateForeignRuntimeRoot(home, location),
    (error) => error.code === 'foreign-history-location', JSON.stringify(location));
  const location = entry.location;
  await rejected({ ...location, baseDataRootPath: home });
  await rejected({ ...location, containerName: location.containerName.replace(/^old-home\//, 'other/') });
  await rejected({ ...location, containerPath: path.join(fixture.base, 'elsewhere', path.basename(archived.backupPath)) });
  await rejected({ ...location, baseDataRootPath: `${fixture.root}/../old-home` });
  await rejected({ ...location, side: undefined });

  // The scope directory of the previous data directory replaced by a link to where the archive now is.
  const scope = fixture.alpha.scopeRoot;
  const moved = path.join(fixture.base, 'moved-scope');
  await fs.rename(scope, moved);
  await fs.symlink(moved, scope, 'dir');
  await assert.rejects(foreign.locateForeignRuntimeRoot(home, location), (error) => error.code === 'foreign-history-link');
});

test('核验结果缓存随文件状态失效：只有 WAL 变了、整个目录被换成另一份同身份的拷贝，都重新核验而不用旧结果', async (t) => {
  const context = await setup(t, 'cache-state');
  const copied = await context.copy(1);
  const first = entryAt(await foreign.inspectForeignRuntimeHistory({ configurationRootPath: context.home }), copied);
  assert.equal(first?.status, 'verified', first?.reason);
  assert.equal(first.summary.conversationCount, 1);

  // Only a WAL appears beside the same database file: a committed conversation the cached result never saw.
  const writer = new Database(context.source.binding.paths.databasePath);
  configureWriterConnection(writer);
  writer.pragma('wal_autocheckpoint = 0');
  writer.prepare('INSERT INTO conversation VALUES (?, ?, ?, ?, ?)').run('wal-only', 'WAL 里的对话', 'active', NOW, NOW);
  await fs.copyFile(`${context.source.binding.paths.databasePath}-wal`, `${databaseOf(copied)}-wal`);
  writer.close();
  const withWal = entryAt(await foreign.inspectForeignRuntimeHistory({ configurationRootPath: context.home }), copied);
  assert.equal(withWal?.status, 'verified', withWal?.reason);
  assert.equal(withWal.summary.conversationCount, 2, '只有 WAL 变了也重新核验');

  // The directory replaced by another copy with the same identity and yet more content.
  const third = new Database(context.source.binding.paths.databasePath);
  try { third.prepare('INSERT INTO conversation VALUES (?, ?, ?, ?, ?)').run('third', '第三个对话', 'active', NOW, NOW); }
  finally { third.close(); }
  await fs.rm(copied, { recursive: true, force: true });
  await context.copy(1);
  const replaced = entryAt(await foreign.inspectForeignRuntimeHistory({ configurationRootPath: context.home }), copied);
  assert.equal(replaced?.id, first.id, '同一个身份、同一个位置');
  assert.equal(replaced.summary.conversationCount, 3, '目录被替换后重新核验');
  assert.notEqual(replaced.contentDigest, withWal.contentDigest);
});
