// Foreign history (runtimeForeignHistory): reset archives and copied data directories registered in
// place and read only. Real archives (archiveCurrentRuntimeRootForReset) and a real relocation's
// copied directory; a filesystem probe proves no access under a recorded path that differs from the
// located one, and every rejection reason is exercised once. Runs against the compiled extension.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import fs from 'node:fs/promises';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {
  compiled, createFixture, createLimCodeTarget, Database, initialize, kernelFile, planWithRuntime, PROJECT, relocate, RootAuthority, seed
} from './runtime-data-root-relocation-fixture.mjs';

const require = createRequire(import.meta.url);
const fsp = require('node:fs/promises');
const fsSync = require('node:fs');
const foreign = kernelFile('runtimeForeignHistory.js');
const { openRuntimeDataSetHistory } = kernelFile('runtimeDataSetHistory.js');
const { deleteUnselectedRuntimeDataSet } = kernelFile('runtimeStorageInspection.js');
const { listVscodeRuntimeDataSets, selectVscodeRuntimeDataSet } = kernelFile('vscodeRootAuthority.js');
const { writeRuntimeDataSetMergeLedgerRecord } = kernelFile('runtimeDataSetMergeLedger.js');
const { ownProcessStartIdentity } = kernelFile('runtimeClaimPrimitives.js');
const { archiveCurrentRuntimeRootForReset } = require(path.join(
  compiled, 'backend/application/reliableKernel/VscodeReliableKernelCutoverCoordinator.js'
));
const NOW = '2026-09-27T00:00:00.000Z';
const TWO_PATH_CALLS = new Set(['copyFile', 'rename', 'link', 'symlink', 'cp', 'copyFileSync', 'renameSync', 'linkSync', 'symlinkSync', 'cpSync']);
const WRITES_FIRST = new Set(['mkdir', 'mkdtemp', 'writeFile', 'appendFile', 'rm', 'rmdir', 'unlink', 'truncate', 'utimes', 'lutimes', 'chmod', 'lchmod', 'chown', 'lchown', 'rename']);
const WRITES_SECOND = new Set(['copyFile', 'cp', 'link', 'symlink', 'rename']);
/** A call that creates, changes or removes something at `call.path`. */
const writes = (call) => {
  const name = call.name.replace(/Sync$/, '');
  return (call.index === 0 && WRITES_FIRST.has(name)) || (call.index === 1 && WRITES_SECOND.has(name))
    || (name === 'open' && call.index === 0 && /[wa+]/.test(String(call.flags ?? 'r')));
};

/** Records every path handed to node:fs (promises and sync) until stopped. */
function probeFilesystem() {
  const seen = [];
  const restore = [];
  const wrap = (module, name) => {
    const original = module[name];
    module[name] = function (...args) {
      for (const [index, arg] of args.slice(0, TWO_PATH_CALLS.has(name) ? 2 : 1).entries()) {
        if (typeof arg === 'string' || arg instanceof URL) {
          seen.push({ name, index, path: path.resolve(arg instanceof URL ? arg.pathname : arg), ...(name.startsWith('open') ? { flags: args[1] } : {}) });
        }
      }
      return original.apply(this, args);
    };
    restore.push(() => { module[name] = original; });
  };
  for (const name of Object.keys(fsp)) if (typeof fsp[name] === 'function') wrap(fsp, name);
  for (const name of Object.keys(fsSync)) {
    if (typeof fsSync[name] === 'function' && /^[a-z]/.test(name) && name !== 'promises') wrap(fsSync, name);
  }
  return { seen, stop() { for (const undo of restore.reverse()) undo(); } };
}

const inside = (root, candidate) => {
  const relative = path.relative(root, candidate);
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
};

/** Every entry below `root`: type, size, times and content; any new directory, sidecar or rewrite changes it. */
async function treeState(root) {
  const result = {};
  async function visit(directory) {
    for (const entry of (await fs.readdir(directory, { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name))) {
      const file = path.join(directory, entry.name);
      const stat = await fs.lstat(file, { bigint: true });
      const key = path.relative(root, file);
      if (entry.isDirectory()) { result[key] = `dir:${stat.ino}:${stat.mtimeNs}`; await visit(file); }
      else result[key] = `file:${stat.ino}:${stat.size}:${stat.mtimeNs}:${stat.ctimeNs}:${createHash('sha256').update(await fs.readFile(file)).digest('hex')}`;
    }
  }
  await visit(root);
  return result;
}

/** dev/ino/size/mtime/ctime of every file below a live root: reading another root must leave each one as it was. */
async function fileStates(root) {
  const result = {};
  async function visit(directory) {
    for (const entry of await fs.readdir(directory, { withFileTypes: true })) {
      const file = path.join(directory, entry.name);
      const stat = await fs.lstat(file, { bigint: true });
      result[path.relative(root, file)] = `${stat.dev}:${stat.ino}:${stat.size}:${stat.mtimeNs}:${stat.ctimeNs}`;
      if (entry.isDirectory()) await visit(file);
    }
  }
  await visit(root);
  return result;
}

async function exists(file) {
  try { await fs.lstat(file); return true; } catch (error) { if (error.code === 'ENOENT') return false; throw error; }
}

async function base(t, name) {
  const directory = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), `limcode-foreign-${name}-`)));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  return directory;
}

async function readAll(paths, root, conversationId) {
  const reader = await openRuntimeDataSetHistory(paths, root);
  try {
    const conversations = (await reader.listConversations()).items.map((item) => item.id);
    const messages = conversationId ? (await reader.readMessages(conversationId)).items.map((item) => item.text) : [];
    return { conversations, messages };
  } finally { await reader.close(); }
}

async function archive(configurationRoot, dataSet) {
  const authority = new RootAuthority(() => dataSet.binding.paths.dataRootPath, undefined, () => configurationRoot);
  const archived = await archiveCurrentRuntimeRootForReset(authority, dataSet.scopeRoot);
  assert.equal(archived.archived, true);
  return { backupPath: archived.backupPath, archived: dataSet.binding, fresh: await initialize(dataSet.scopeRoot, dataSet.id) };
}

test('迁移挪开的拷来目录：核验、只读查看与存储统计只经 located 路径，原件所在的 recorded 路径从不被访问，拷来目录一字节不变', async (t) => {
  const fixture = await createFixture(t, { withAlpha: false });
  const elsewhere = path.join(fixture.base, 'elsewhere');
  const original = await createLimCodeTarget(elsewhere, { conversations: [{ id: 'conversation_elsewhere_1', project: PROJECT }] });
  const copied = path.join(fixture.base, 'copied');
  await fs.cp(elsewhere, copied, { recursive: true });
  const plan = await planWithRuntime(fixture, copied);
  assert.equal(plan.target.kind, 'copied');
  const { staged } = await relocate(fixture, plan);
  const [aside] = (await fs.readdir(fixture.base)).filter((name) => name.startsWith('copied.limcode-copied-'));
  assert.ok(aside, '迁移把拷来的数据挪到了旁边');
  const asidePath = path.join(fixture.base, aside);
  const asideBefore = await treeState(asidePath);
  const elsewhereBefore = await treeState(elsewhere);
  const paths = { globalStoragePath: copied };

  const probe = probeFilesystem();
  let report; let read; let storage; let root;
  try {
    report = await foreign.inspectForeignRuntimeHistory({ configurationRootPath: copied, previousDataRootPath: fixture.root });
    const entry = report.entries.find((item) => item.location.containerName === aside);
    assert.equal(entry?.status, 'verified', entry?.reason);
    root = await foreign.locateForeignRuntimeRoot(copied, entry.location);
    read = await readAll(paths, root, 'conversation_elsewhere_1');
    storage = await foreign.inspectForeignRuntimeStorage(paths, root);
  } finally { probe.stop(); }
  assert.deepEqual(probe.seen.filter((call) => inside(elsewhere, call.path)), [], '原件所在位置从不被访问');
  assert.ok(probe.seen.some((call) => call.name === 'copyFile' && call.index === 0 && call.path === root.located.databasePath), '快照复制自 located 数据库');
  assert.ok(probe.seen.filter((call) => call.name === 'copyFile' && call.index === 1).every((call) => !inside(asidePath, call.path)), '从不向拷来目录写入');
  assert.deepEqual(probe.seen.filter((call) => writes(call) && (inside(asidePath, call.path) || (inside(path.dirname(asidePath), call.path) && !inside(copied, call.path)))), [],
    '拷来目录里和它旁边都不新建、不改写、不删除任何东西（声明与缓存只在当前配置根）');

  const entry = report.entries.find((item) => item.location.containerName === aside);
  assert.equal(entry.location.kind, 'copied');
  assert.equal(entry.location.side, 'current');
  assert.equal(entry.movedAsideBy, staged.relocationId);
  assert.equal(entry.scope, 'default');
  assert.match(entry.id, /^foreign:copied:[0-9a-f]{16}$/);
  assert.equal(entry.recordedDataRootPath, original.binding.paths.dataRootPath);
  assert.equal(entry.locatedPath, path.join(asidePath, '.limcode-runtime', 'active'));
  assert.notEqual(root.recorded.paths.dataRootPath, root.located.dataRootPath);
  assert.equal(entry.summary.conversationCount, 1);
  assert.equal(entry.sameAsLocal, undefined);
  assert.deepEqual(read.conversations, ['conversation_elsewhere_1']);
  assert.deepEqual(read.messages, ['conversation_elsewhere_1 的正文']);
  assert.equal(storage.candidateId, entry.id);
  assert.ok(BigInt(storage.categories.sqlite.bytes) > 0n && storage.categories.cas.fileCount === 1);
  // Nothing was created in the copied directory or beside the original; results and claims live here.
  assert.deepEqual(await treeState(asidePath), asideBefore);
  assert.deepEqual(await treeState(elsewhere), elsewhereBefore);
  assert.ok(await exists(path.join(copied, '.limcode-runtime-merges', 'foreign', `${entry.id.replace(/:/g, '-')}.json`)));
  assert.deepEqual(await fs.readdir(path.join(copied, '.limcode-runtime-merges', 'foreign-claims')).catch(() => []), [], '声明用完即释放');
});

for (const scopeKind of ['default', 'workspace']) {
  test(`${scopeKind}真实归档原位登记：查看它只经 located，不碰占着原位置的现存根，现存根文件状态逐一不变；删除本地库后归档仍在并作为外来库出现`, async (t) => {
    const fixture = await createFixture(t);
    const target = scopeKind === 'default' ? fixture.current : fixture.alpha;
    const survivor = scopeKind === 'default' ? fixture.alpha : fixture.current;
    const conversationId = scopeKind === 'default' ? 'conversation_current_1' : 'conversation_alpha_1';
    const { backupPath, archived, fresh } = await archive(fixture.root, target);
    const liveControl = path.dirname(fresh.binding.paths.rootPointerPath);
    assert.equal(archived.paths.dataRootPath, fresh.binding.paths.dataRootPath, '归档记录的正是现存根的位置');
    const liveBefore = await fileStates(liveControl);
    const archiveBefore = await treeState(backupPath);

    const archives = path.dirname(backupPath);
    const inspectProbe = probeFilesystem();
    let report;
    try { report = await foreign.inspectForeignRuntimeHistory({ configurationRootPath: fixture.root }); }
    finally { inspectProbe.stop(); }
    assert.deepEqual(inspectProbe.seen.filter((call) => writes(call) && (inside(archives, call.path) || inside(liveControl, call.path))), [],
      '核验时归档目录与现存根都不被写入');
    const entry = report.entries.find((item) => item.location.containerPath === backupPath);
    assert.equal(entry?.status, 'verified', entry?.reason);
    assert.equal(entry.location.kind, 'archive');
    assert.equal(entry.recordedDataRootPath, fresh.binding.paths.dataRootPath);
    assert.equal(entry.dataSetId, archived.dataSetId);
    assert.equal(entry.sameAsLocal, undefined, '与占着原位置的新库身份不同');
    const probe = probeFilesystem();
    let read;
    try {
      const root = await foreign.locateForeignRuntimeRoot(fixture.root, entry.location);
      read = await readAll(fixture.paths, root, conversationId);
      await foreign.inspectForeignRuntimeStorage(fixture.paths, root);
    } finally { probe.stop(); }
    assert.deepEqual(probe.seen.filter((call) => inside(liveControl, call.path)), [], '现存根从不被访问');
    assert.deepEqual(probe.seen.filter((call) => writes(call) && inside(archives, call.path)), [], '查看时不在归档目录里建声明或任何文件');
    assert.deepEqual(read.conversations, scopeKind === 'default' ? ['conversation_current_2', 'conversation_current_1'] : [conversationId]);
    assert.deepEqual(read.messages, [`${conversationId} 的正文`]);
    assert.deepEqual(await fileStates(liveControl), liveBefore);
    assert.deepEqual(await treeState(backupPath), archiveBefore);

    // Deleting the local data set of that scope keeps the archive, which stays a foreign entry.
    await selectVscodeRuntimeDataSet(fixture.paths, survivor.id);
    const current = (await listVscodeRuntimeDataSets(fixture.paths)).find((candidate) => candidate.id === target.id);
    await deleteUnselectedRuntimeDataSet(fixture.paths, target.id, current.dataSetId);
    assert.deepEqual(await treeState(backupPath), archiveBefore, '删除本地库不连带删除归档');
    assert.deepEqual((await listVscodeRuntimeDataSets(fixture.paths)).map((candidate) => candidate.id), [survivor.id]);
    const after = await foreign.inspectForeignRuntimeHistory({ configurationRootPath: fixture.root });
    const kept = after.entries.find((item) => item.location.containerPath === backupPath);
    assert.equal(kept?.status, 'verified', kept?.reason);
    assert.equal(kept.id, entry.id);
    const root = await foreign.locateForeignRuntimeRoot(fixture.root, kept.location);
    assert.deepEqual((await readAll(fixture.paths, root, conversationId)).messages, [`${conversationId} 的正文`]);
  });
}

test('启动发现只列目录、读小 JSON：找到上一个数据目录旁的拷来目录与拷来目录里的各库和归档，不碰任何 SQLite 文件', async (t) => {
  const directory = await base(t, 'discover');
  const home = path.join(directory, 'home');
  const previous = path.join(directory, 'previous');
  await createLimCodeTarget(home);
  const elsewhere = path.join(directory, 'elsewhere');
  const source = await createLimCodeTarget(elsewhere);
  const workspace = await initialize(path.join(elsewhere, '.limcode-workspace-runtimes', 'scopes', `folder-${'a'.repeat(64)}`), 'workspace:x');
  await archive(elsewhere, { ...workspace, scopeRoot: path.join(elsewhere, '.limcode-workspace-runtimes', 'scopes', `folder-${'a'.repeat(64)}`) });
  const copiedName = 'previous.limcode-copied-2026-09-02T01-02-03-004Z-12345678';
  await fs.cp(elsewhere, path.join(directory, copiedName), { recursive: true });
  await fs.mkdir(path.join(directory, 'previous.limcode-copied-not-a-relocation'), { recursive: true });
  const probe = probeFilesystem();
  let found;
  try { found = await foreign.discoverForeignRuntimeHistory({ configurationRootPath: home, previousDataRootPath: previous }); }
  finally { probe.stop(); }
  assert.deepEqual(found.map((entry) => [entry.location.side, entry.location.dataRootRelativePath]), [
    ['previous', '.limcode-runtime/active'],
    ['previous', `.limcode-workspace-runtimes/scopes/folder-${'a'.repeat(64)}/.limcode-runtime/active`],
    ['previous', `.limcode-workspace-runtimes/scopes/folder-${'a'.repeat(64)}/.limcode-runtime-backups/${found[2].archiveName}/active`]
  ]);
  assert.equal(found[0].id, foreign.foreignRuntimeHistoryId(found[0].location, source.binding));
  assert.deepEqual(probe.seen.filter((call) => /limcode\.sqlite/.test(call.path)), []);
  assert.deepEqual(probe.seen.filter((call) => !['lstat', 'readdir', 'readFile'].includes(call.name)).map((call) => call.name), []);
  assert.ok(probe.seen.filter((call) => call.name === 'readFile').every((call) => call.path.endsWith('.json')));
});

/** A complete copy of a LimCode directory beside `home`, named as a relocation names copied data. */
async function copiedBeside(home, source, suffix) {
  const target = `${home}.limcode-copied-2026-09-0${suffix}T01-02-03-004Z-${String(suffix).repeat(8).slice(0, 8)}`;
  await fs.cp(source, target, { recursive: true });
  return target;
}

test('每种拒绝原因各一例：未通过的列出位置、大小与原因并原样保留；磁盘满与复制中变化只是暂时无法核验、不入缓存', async (t) => {
  const directory = await base(t, 'reasons');
  const elsewhere = path.join(directory, 'elsewhere');
  const source = await createLimCodeTarget(elsewhere);
  const control = (copied) => path.join(copied, '.limcode-runtime');
  const pointer = (copied) => path.join(control(copied), 'root-binding.json');
  const database = (copied) => path.join(control(copied), 'active', 'limcode.sqlite');
  const cases = [
    ['foreign-history-link', 'failed', async (home) => { await fs.symlink(elsewhere, `${home}.limcode-copied-2026-09-01T01-02-03-004Z-11111111`, 'dir'); }],
    ['foreign-history-no-runtime', 'failed', async (home) => {
      const copied = `${home}.limcode-copied-2026-09-01T01-02-03-004Z-11111111`;
      await fs.mkdir(copied); await fs.writeFile(path.join(copied, 'notes.txt'), 'user file');
    }],
    ['foreign-history-incomplete', 'failed', async (home) => fs.rm(database(await copiedBeside(home, elsewhere, 1)))],
    ['foreign-history-pointer-invalid', 'failed', async (home) => fs.writeFile(pointer(await copiedBeside(home, elsewhere, 1)), '{broken')],
    ['foreign-history-unfinished-operation', 'failed', async (home) => fs.writeFile(path.join(control(await copiedBeside(home, elsewhere, 1)), 'root-binding.pending.json'), '{}')],
    ['foreign-history-rollback-journal', 'failed', async (home) => fs.writeFile(`${database(await copiedBeside(home, elsewhere, 1))}-journal`, 'x')],
    ['foreign-history-recorded-paths', 'failed', async (home) => {
      const copied = await copiedBeside(home, elsewhere, 1);
      const value = JSON.parse(await fs.readFile(pointer(copied), 'utf8'));
      value.paths.casRootPath = path.join(directory, 'somewhere-else', 'cas');
      await fs.writeFile(pointer(copied), JSON.stringify(value));
    }],
    ['foreign-history-epoch-manifest', 'failed', async (home) => {
      const file = path.join(control(await copiedBeside(home, elsewhere, 1)), 'active', 'runtime-kernel-epoch.json');
      await fs.writeFile(file, JSON.stringify({ ...JSON.parse(await fs.readFile(file, 'utf8')), extra: true }));
    }],
    ['foreign-history-epoch-not-current', 'failed', async (home) => {
      const copied = await copiedBeside(home, elsewhere, 1);
      const epochFile = path.join(control(copied), 'active', 'runtime-kernel-epoch.json');
      await fs.writeFile(pointer(copied), JSON.stringify({ ...JSON.parse(await fs.readFile(pointer(copied), 'utf8')), runtimeKernelEpoch: 4 }));
      await fs.writeFile(epochFile, JSON.stringify({ ...JSON.parse(await fs.readFile(epochFile, 'utf8')), runtimeKernelEpoch: 4 }));
    }],
    ['foreign-history-unfinished-relocation', 'failed', async (home) => {
      await fs.writeFile(path.join(await copiedBeside(home, elsewhere, 1), '.limcode-data-root-relocation.json'),
        JSON.stringify({ kind: 'limcode-data-root-relocation', state: 'staging' }));
    }],
    ['foreign-history-unfinished-merge', 'failed', async (home) => {
      const copied = await copiedBeside(home, elsewhere, 1);
      const identity = { dataSetId: source.binding.dataSetId, rootInstanceId: source.binding.rootInstanceId };
      await writeRuntimeDataSetMergeLedgerRecord({ globalStoragePath: copied }, {
        candidateId: 'workspace:other', state: 'committing', commitId: 'commit-1', target: identity,
        source: { dataSetId: 'other', rootInstanceId: 'other', rootGeneration: 1, pointerRevision: 1, contentDigest: 'x' }
      });
    }],
    ['foreign-history-hosts-active', 'unavailable', async (home) => {
      const liveness = path.join(control(await copiedBeside(home, elsewhere, 1)), 'active', 'host-liveness');
      await fs.mkdir(liveness, { recursive: true });
      await fs.writeFile(path.join(liveness, 'fixture.json'), JSON.stringify({
        dataSetId: source.binding.dataSetId, rootInstanceId: source.binding.rootInstanceId, rootGeneration: 1, hostBootId: 'h',
        livenessId: 'l', processId: process.pid, processStartIdentity: ownProcessStartIdentity(), startedAt: NOW, heartbeatAt: NOW
      }));
    }],
    ['foreign-history-audit-failed', 'failed', async (home) => {
      const sqlite = new Database(database(await copiedBeside(home, elsewhere, 1)));
      try { sqlite.exec('CREATE TABLE unexpected_extra(x)'); } finally { sqlite.close(); }
    }],
    ['foreign-history-open-database', 'failed', async (home) => {
      await fs.rm(home, { recursive: true, force: true });
      await createLimCodeTarget(home);
      const copied = await copiedBeside(home, home, 1);
      await fs.rm(database(copied));
      await fs.link(database(home), database(copied));
    }],
    ['foreign-history-copy-failed', 'unavailable', async (home, t) => {
      const copied = await copiedBeside(home, elsewhere, 1);
      const copyFile = fsp.copyFile;
      fsp.copyFile = async function (from, ...rest) {
        if (inside(copied, path.resolve(String(from)))) throw Object.assign(new Error('ENOSPC: no space left on device'), { code: 'ENOSPC' });
        return copyFile.call(this, from, ...rest);
      };
      t.after(() => { fsp.copyFile = copyFile; });
    }],
    ['foreign-history-changing', 'unavailable', async (home, t) => {
      const copied = await copiedBeside(home, elsewhere, 1);
      const copyFile = fsp.copyFile;
      let tick = 0;
      fsp.copyFile = async function (from, ...rest) {
        const result = await copyFile.call(this, from, ...rest);
        if (path.resolve(String(from)) === database(copied)) { tick += 1; await fs.utimes(from, new Date(), new Date(Date.now() + tick * 1000)); }
        return result;
      };
      t.after(() => { fsp.copyFile = copyFile; });
    }]
  ];
  for (const [code, status, arrange] of cases) {
    await t.test(code, async (sub) => {
      const home = path.join(await base(sub, code.replace('foreign-history-', '')), 'home');
      await fs.mkdir(home);
      await arrange(home, sub);
      const [copiedName] = (await fs.readdir(path.dirname(home))).filter((name) => name.startsWith('home.limcode-copied-'));
      const copied = path.join(path.dirname(home), copiedName);
      const stat = await fs.lstat(copied);
      const before = stat.isSymbolicLink() ? undefined : await treeState(copied);
      const report = await foreign.inspectForeignRuntimeHistory({ configurationRootPath: home });
      const entry = report.entries.find((item) => item.location.containerPath === copied);
      assert.equal(entry?.status, status, JSON.stringify(entry));
      assert.equal(entry.code, code);
      assert.ok(entry.reason.length > 0);
      assert.equal(typeof entry.size?.bytes, 'string');
      if (status === 'unavailable') assert.match(entry.reason, /暂时无法核验|关闭后再核验|稍后/);
      // The changing case rewrites the source's time stamp itself; every other case leaves it exactly as it was.
      if (before && code !== 'foreign-history-changing') assert.deepEqual(await treeState(copied), before, '原样保留');
      const cache = path.join(home, '.limcode-runtime-merges', 'foreign', `${entry.id.replace(/:/g, '-')}.json`);
      if (status === 'unavailable') assert.equal(await exists(cache), false, '暂时无法核验不入缓存');
    });
  }
  await assert.rejects(foreign.locateForeignRuntimeRoot(directory, {
    kind: 'copied', side: 'current', baseDataRootPath: directory, containerPath: elsewhere, containerName: 'elsewhere', dataRootRelativePath: '.limcode-runtime/active'
  }), (error) => error.code === 'foreign-history-location' && error.status === 'failed');
});

test('身份关系：当前库的拷贝记为旧拷贝；两份完全相同的外来拷贝只显示一份，内容不同则分别列出；结果按确切文件状态缓存', async (t) => {
  const directory = await base(t, 'identity');
  const home = path.join(directory, 'home');
  await createLimCodeTarget(home);
  const snapshot = path.join(directory, 'snapshot');
  await fs.cp(home, snapshot, { recursive: true });
  const first = await copiedBeside(home, snapshot, 1);
  const second = await copiedBeside(home, snapshot, 2);
  const third = await copiedBeside(home, snapshot, 3);
  const sqlite = new Database(path.join(third, '.limcode-runtime', 'active', 'limcode.sqlite'));
  try { sqlite.prepare('INSERT INTO conversation VALUES (?, ?, ?, ?, ?)').run('only-in-third', 'only-in-third', 'active', NOW, NOW); }
  finally { sqlite.close(); }
  const report = await foreign.inspectForeignRuntimeHistory({ configurationRootPath: home });
  const byPath = (copied) => report.entries.find((entry) => entry.location.containerPath === copied);
  for (const copied of [first, second, third]) {
    assert.equal(byPath(copied).status, 'verified', byPath(copied).reason);
    assert.deepEqual(byPath(copied).sameAsLocal, { candidateId: 'default', selected: true });
  }
  assert.equal(byPath(first).duplicateOf, undefined);
  assert.equal(byPath(second).duplicateOf, byPath(first).id);
  assert.equal(byPath(third).duplicateOf, undefined);
  assert.notEqual(byPath(third).contentDigest, byPath(first).contentDigest);

  const copies = [];
  const copyFile = fsp.copyFile;
  fsp.copyFile = async function (from, ...rest) { copies.push(path.resolve(String(from))); return copyFile.call(this, from, ...rest); };
  try {
    await foreign.inspectForeignRuntimeHistory({ configurationRootPath: home });
    assert.deepEqual(copies, [], '文件状态没变就用缓存');
    await fs.utimes(path.join(first, '.limcode-runtime', 'active', 'limcode.sqlite'), new Date(), new Date(Date.now() + 5000));
    const again = await foreign.inspectForeignRuntimeHistory({ configurationRootPath: home });
    assert.deepEqual(copies, [path.join(first, '.limcode-runtime', 'active', 'limcode.sqlite')], '只有变了的重新核验');
    assert.equal(again.entries.find((entry) => entry.location.containerPath === first).status, 'verified');
  } finally { fsp.copyFile = copyFile; }
});

test('只读查看期间外来库的记录变了（指针代数被改）：读取器拒绝继续读，不返回可能过时的内容；源目录未被写入', async (t) => {
  const directory = await base(t, 'reader');
  const home = path.join(directory, 'home');
  await fs.mkdir(home);
  const elsewhere = path.join(directory, 'elsewhere');
  await createLimCodeTarget(elsewhere);
  const copied = await copiedBeside(home, elsewhere, 1);
  const report = await foreign.inspectForeignRuntimeHistory({ configurationRootPath: home });
  const entry = report.entries.find((item) => item.location.containerPath === copied);
  assert.equal(entry?.status, 'verified', entry?.reason);
  const reader = await openRuntimeDataSetHistory({ globalStoragePath: home }, await foreign.locateForeignRuntimeRoot(home, entry.location));
  try {
    assert.deepEqual((await reader.listConversations()).items.map((item) => item.id), ['conversation_existing_1']);
    const pointer = path.join(copied, '.limcode-runtime', 'root-binding.json');
    const value = JSON.parse(await fs.readFile(pointer, 'utf8'));
    await fs.writeFile(pointer, JSON.stringify({ ...value, pointerRevision: value.pointerRevision + 1 }));
    await assert.rejects(reader.listConversations(), /identity changed/);
    await assert.rejects(reader.readMessages('conversation_existing_1'), /identity changed/);
  } finally { await reader.close(); }
});
