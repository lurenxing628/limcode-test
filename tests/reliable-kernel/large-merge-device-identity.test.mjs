import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {
  createConfigurationRoot, kernelFile, messageText, removeConfigurationRoot, seedConversations, SHARED_TEXT, withRuntime
} from './fixtures/runtime-merge-fixture.mjs';

const { largeMergeDiskDevice, largeMergeDiskNeeds, largeMergeSessionSpace } = kernelFile('runtimeDataSetLargeMergeSpace.js');
const { planDataRootRelocation } = kernelFile('runtimeDataRootRelocation.js');
const MiB = 1024 * 1024;
const margin = 64 * MiB;
const space = {
  targetDirectory: path.resolve('synthetic-target'), targetBytes: 128 * MiB,
  temporaryDirectory: path.resolve('synthetic-copies'), temporaryBytes: 100 * MiB,
  sqliteTemporaryDirectory: path.resolve('synthetic-sqlite'), sqliteTemporaryBytes: 25 * MiB
};

test('missing device IDs keep each disk free-space check instead of borrowing target capacity', () => {
  const disks = largeMergeDiskNeeds(space, {
    target: { device: 0, freeBytes: 1024 * MiB },
    temporary: { device: 0, freeBytes: MiB },
    sqliteTemporary: { device: 0, freeBytes: MiB }
  }, margin);
  assert.equal(disks.length, 3);
  assert.equal(disks.find(disk => disk.path === space.temporaryDirectory).missingBytes, 252 * MiB);
  assert.equal(disks.find(disk => disk.path === space.sqliteTemporaryDirectory).missingBytes, 252 * MiB);
  assert.ok(disks.every(disk => disk.requiredBytes === 253 * MiB));
});

test('unknown directories reserve simultaneous use of one disk instead of passing each use separately', () => {
  const facts = largeMergeSessionSpace({
    ...space, targetFilesBytes: MiB, sources: [{ databaseBytes: 100 * MiB, casCopyBytes: 0 }], marginBytes: margin
  });
  const capacity = 330 * MiB;
  assert.ok(facts.targetBytes < capacity);
  assert.ok(facts.temporaryBytes + margin < capacity);
  assert.ok(facts.sqliteTemporaryBytes + margin < capacity);
  const disks = largeMergeDiskNeeds(facts, {
    target: { device: 0, freeBytes: capacity },
    temporary: { freeBytes: capacity },
    sqliteTemporary: { device: 0, freeBytes: capacity }
  }, margin);
  const combined = facts.targetBytes + facts.temporaryBytes + facts.sqliteTemporaryBytes;
  assert.ok(combined > capacity);
  assert.ok(disks.every(disk => disk.requiredBytes === combined && disk.missingBytes === combined - capacity));
});

test('mixed identities add unknown demands to each compatible known disk without combining different known disks', () => {
  const disks = largeMergeDiskNeeds(space, {
    target: { device: 7, freeBytes: 220 * MiB },
    temporary: { device: 0, freeBytes: 230 * MiB },
    sqliteTemporary: { device: 8, freeBytes: 200 * MiB }
  }, margin);
  assert.equal(disks.length, 3);
  assert.equal(disks.find(disk => disk.path === space.targetDirectory).requiredBytes, 228 * MiB);
  assert.equal(disks.find(disk => disk.path === space.targetDirectory).missingBytes, 8 * MiB);
  assert.equal(disks.find(disk => disk.path === space.temporaryDirectory).requiredBytes, 228 * MiB);
  assert.equal(disks.find(disk => disk.path === space.sqliteTemporaryDirectory).requiredBytes, 189 * MiB);
});

test('known different disks keep independent budgets even when their total exceeds every capacity', () => {
  const disks = largeMergeDiskNeeds(space, {
    target: { device: 7, freeBytes: 170 * MiB },
    temporary: { device: 8, freeBytes: 170 * MiB },
    sqliteTemporary: { device: 9, freeBytes: 170 * MiB }
  }, margin);
  assert.deepEqual(disks.map(disk => disk.requiredBytes), [128 * MiB, 164 * MiB, 89 * MiB]);
  assert.ok(disks.every(disk => disk.missingBytes === 0));
});

test('one unknown path combines its uses once, retains the tightest probe and keeps one margin', () => {
  const disks = largeMergeDiskNeeds({
    ...space, temporaryDirectory: space.targetDirectory, sqliteTemporaryDirectory: path.join(space.targetDirectory, '.')
  }, {
    target: { device: 0, freeBytes: 300 * MiB },
    temporary: { freeBytes: 250 * MiB },
    sqliteTemporary: { device: 0, freeBytes: 280 * MiB }
  }, margin);
  assert.equal(disks.length, 1);
  assert.equal(disks[0].requiredBytes, 253 * MiB);
  assert.equal(disks[0].freeBytes, 250 * MiB);
  assert.equal(disks[0].missingBytes, 3 * MiB);
});

test('an unknown temporary disk also retains its own margin when the target demand is smaller', () => {
  const disks = largeMergeDiskNeeds({ ...space, targetBytes: MiB, sqliteTemporaryBytes: 0 }, {
    target: { device: 7, freeBytes: 500 * MiB }, temporary: { device: 0, freeBytes: 500 * MiB },
    sqliteTemporary: { device: 8, freeBytes: 500 * MiB }
  }, margin);
  assert.equal(disks.find(disk => disk.path === space.temporaryDirectory).requiredBytes, 164 * MiB);
});

test('known equal devices still combine their bytes and keep one disk margin', () => {
  const disks = largeMergeDiskNeeds(space, {
    target: { device: 7, freeBytes: 1024 * MiB },
    temporary: { device: 7, freeBytes: 1024 * MiB },
    sqliteTemporary: { device: 8, freeBytes: MiB }
  }, margin);
  assert.equal(disks.length, 2);
  assert.equal(disks.find(disk => disk.path === space.targetDirectory).requiredBytes, 228 * MiB);
  assert.equal(disks.find(disk => disk.path === space.sqliteTemporaryDirectory).requiredBytes, 89 * MiB);
});

test('native disk probes treat zero as unavailable while retaining per-directory free space', async (t) => {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'limcode-device-probe-')));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const directories = ['target', 'copies', 'sqlite'].map(name => path.join(root, name));
  for (const directory of directories) await fs.mkdir(directory);
  const available = new Map(directories.map((directory, index) => [directory, index === 0 ? 1024 * MiB : MiB]));
  const originalStat = fs.stat, originalStatfs = fs.statfs;
  t.mock.method(fs, 'stat', async (input, ...args) => {
    const stat = await originalStat(input, ...args);
    if (available.has(String(input))) stat.dev = 0;
    return stat;
  });
  t.mock.method(fs, 'statfs', async (input, ...args) => {
    const stat = await originalStatfs(input, ...args);
    if (available.has(String(input))) {
      stat.bsize = 4096;
      stat.bavail = available.get(String(input)) / stat.bsize;
    }
    return stat;
  });
  assert.equal(await largeMergeDiskDevice(directories[1]), undefined);

});

test('data-root relocation does not assume hard links when directory device identities are unavailable', async (t) => {
  const fixture = await createConfigurationRoot();
  const target = await fs.mkdtemp(path.join(path.dirname(fixture.root), 'limcode-unknown-relocation-target-'));
  t.after(async () => { await removeConfigurationRoot(fixture.root); await fs.rm(target, { recursive: true, force: true }); });
  await seedConversations(fixture.current, [{ id: 'relocation-volume-source' }]);
  const originalStat = fs.stat;
  let probes = 0;
  t.mock.method(fs, 'stat', async (input, ...args) => {
    const stat = await originalStat(input, ...args);
    if (stat.isDirectory()) { stat.dev = args[0]?.bigint ? 0n : 0; probes++; }
    return stat;
  });
  await withRuntime(fixture.current, async (database) => {
    const plan = await planDataRootRelocation({ sourceRootPath: fixture.root, targetRootPath: target, sourceDatabase: database });
    assert.ok(probes >= 3, 'exercise source, target and temporary directory probes');
    assert.equal(plan.sameDevice, false);
    assert.equal(plan.hardLinks, false);
    assert.equal(plan.space.length, 3);
    const destination = plan.space.find(disk => disk.label === '新数据目录');
    assert.ok(destination.requiredBytes >= 4 * plan.current.databaseBytes + plan.current.casAllocatedBytes + margin,
      'include CAS copies and simultaneous target, old-root staging and temporary use with one margin');
    assert.ok(plan.space.every(disk => disk.requiredBytes === destination.requiredBytes));
    const freeBytes = destination.requiredBytes - Math.max(1, Math.floor(plan.current.databaseBytes / 2));
    const originalStatfs = fs.statfs;
    t.mock.method(fs, 'statfs', async (input, ...args) => {
      const stat = await originalStatfs(input, ...args);
      stat.bsize = 1;
      stat.bavail = freeBytes;
      return stat;
    });
    const denied = await planDataRootRelocation({ sourceRootPath: fixture.root, targetRootPath: target, sourceDatabase: database });
    assert.ok(denied.space.every(disk => disk.freeBytes === freeBytes && disk.requiredBytes > freeBytes));
    assert.ok(denied.problems.some(problem => /迁移过程中大约需要/.test(problem)));
  });
});
