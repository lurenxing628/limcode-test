// Large-merge session after its review (second part): target backups that outlive their window,
// cleanup failures that must not undo an outcome, disk space, invariants, conflicts, the closure.
import assert from 'node:assert/strict';
import { execFile, spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { createRequire } from 'node:module';
import fs from 'node:fs/promises';
import fsSync from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import {
  compiled, countRows, createConfigurationRoot, Database, kernel, kernelFile, ledgerEntries, NOW, rawWrite, readAll, readLedgerRecord,
  removeConfigurationRoot, saveState, seedConversations, seedRichSource
} from './fixtures/runtime-merge-fixture.mjs';

const require = createRequire(import.meta.url);
const fsPromises = require('node:fs/promises');
const { HISTORICAL_MERGE_ENGINE, mergeHistoricalDataSetsOnline, RUNTIME_DATA_SET_MERGE_AWAITING_EXCLUSIVE } = kernelFile('runtimeDataSetMerge.js');
const {
  estimateLargeMergeSources, prepareLargeMergeSources, releaseLargeMergePreparation, runLargeMergeSession
} = kernelFile('runtimeDataSetStreamedMerge.js');
const { estimatedTargetIndexBytes, largeMergeTargetBytes } = kernelFile('runtimeDataSetLargeMergeSpace.js');
const { isRuntimeLargeMergeTargetBackupLive } = kernelFile('runtimeDataSetMergeLedger.js');
const { openRuntimeCasVerificationCache } = kernelFile('runtimeCasVerificationCache.js');
const { withRuntimeDataRootAdmission, withRuntimeMaintenance } = kernelFile('runtimeHostControl.js');
const { resolveVscodeRuntimeMergeLedgerRoot } = kernelFile('vscodeRootAuthority.js');
const { RuntimeDatabaseWorkerError } = kernelFile('runtimeDatabase.js');
const { ConversationDeletionControlPlane } = kernelFile('conversationDeletion.js');
const HERE = path.dirname(fileURLToPath(import.meta.url));
const LIMITS = { sizeLimits: { transactionRows: 50 }, chunkRows: 7 };
const MiB = 1024 * 1024;
const DISK_FULL = 'runtime-data-set-merge-disk-full';
const INVARIANT = 'runtime-data-set-merge-invariant';

// ---------------------------------------------------------------------------------------------
// Target backups (review #1) and failures while cleaning up (#13, #14).
// ---------------------------------------------------------------------------------------------

test('准备好的窗口在会话之前消失（关窗、重载、崩溃）：它做的目标备份登记在盘上，下一次批次或准备清理过期准备时连同备份删掉，不会一次次累积', { timeout: 300_000 }, async (t) => {
  const fixture = await createConfigurationRoot();
  t.after(() => removeConfigurationRoot(fixture.root));
  await seedRichSource(fixture.alpha, 'alpha', 3);

  const first = await runChild(t, fixture, { fault: { point: 'after-cas-transfer' } });
  assert.equal(first.signal, 'SIGKILL', first.stderr);
  const [leaked] = await targetBackups(fixture);
  assert.ok(leaked, '准备做了目标在线备份');
  const [registration] = await registrations(fixture);
  assert.equal(registration.name, leaked, '备份登记在盘上');
  assert.equal(registration.used, false, '没有会话在它上面开始');
  assert.equal(registration.backupPath, path.join(backupsDirectory(fixture), leaked));

  // Next startup: the batch leaves the source to the session and prunes what the dead window held.
  await withWindow(fixture, async (window) => {
    const batch = await mergeHistoricalDataSetsOnline(fixture.paths, { configurationRootPath: fixture.root, database: window }, { sizeLimits: LIMITS.sizeLimits });
    assert.equal(batch.deferred.length, 1);
  });
  assert.deepEqual(await targetBackups(fixture), [], '死掉窗口的备份随过期准备删掉');
  assert.deepEqual(await registrations(fixture), []);
  assert.deepEqual(await ledgerEntries(fixture, 'preparing'), []);

  // Again, and this time the next preparation cleans up before taking its own backup.
  const second = await runChild(t, fixture, { fault: { point: 'after-cas-transfer' } });
  assert.equal(second.signal, 'SIGKILL', second.stderr);
  const [leakedAgain] = await targetBackups(fixture);
  assert.ok(leakedAgain);
  await withWindow(fixture, async (window) => {
    let beforeItsOwn;
    const again = await prepareLargeMergeSources({
      paths: fixture.paths, target: { configurationRootPath: fixture.root, database: window }, options: LIMITS,
      onProgress: (progress) => { if (progress.stage === 'backup') beforeItsOwn ??= backupNamesNow(fixture); }
    });
    assert.equal(again.sources.length, 1, '死掉窗口的准备记录可以接手');
    assert.deepEqual(beforeItsOwn, [], '准备开始时先清理过期准备，再做自己的备份');
    assert.deepEqual(await targetBackups(fixture), [path.basename(again.backupPath)], '只剩这次准备自己的备份');
    assert.deepEqual((await registrations(fixture)).map((entry) => entry.name), [path.basename(again.backupPath)]);
    await releaseLargeMergePreparation(again);
  });
  assert.deepEqual(await targetBackups(fixture), []);
  assert.deepEqual(await registrations(fixture), [], '释放时登记也撤掉');
});

test('写第二份来源的准备记录遇到 ENOSPC（盲审 #5）：第二份按磁盘空间不足推迟（中文、写明目录、没有系统原文），第一份照常准备好；释放时目标备份、登记和声明都交还', { timeout: 300_000 }, async (t) => {
  const fixture = await createConfigurationRoot({ beta: true });
  t.after(() => removeConfigurationRoot(fixture.root));
  await seedRichSource(fixture.alpha, 'alpha', 3);
  await seedRichSource(fixture.beta, 'beta', 3);
  const open = fsPromises.open;
  let claims = 0;
  fsPromises.open = async (file, ...rest) => {
    if (String(file).includes(`${path.sep}preparing${path.sep}`) && String(file).endsWith('.tmp') && ++claims === 2) {
      throw Object.assign(new Error(`ENOSPC: no space left on device, open '${file}'`), { code: 'ENOSPC', syscall: 'open', path: String(file) });
    }
    return open(file, ...rest);
  };
  let preparation;
  try {
    preparation = await withWindow(fixture, (window) => prepareLargeMergeSources({
      paths: fixture.paths, target: { configurationRootPath: fixture.root, database: window }, options: LIMITS
    }));
  } finally {
    fsPromises.open = open;
  }
  assert.equal(claims >= 2, true, '第二份来源的准备记录写失败了');
  assert.equal(preparation.sources.length, 1, '第一份照常准备好');
  const [first] = preparation.sources;
  assert.deepEqual(preparation.report.deferred.map((issue) => issue.code), [DISK_FULL]);
  const { message } = preparation.report.deferred[0];
  assert.equal(message, `磁盘空间不足：准备合并这份旧聊天记录时在 ${path.join(resolveVscodeRuntimeMergeLedgerRoot(fixture.paths), 'preparing')} 写不下了，这次没有合并；腾出空间后会再合并`);
  assert.notEqual(preparation.report.deferred[0].candidateId, first.candidateId);
  assert.deepEqual(await targetBackups(fixture), [path.basename(preparation.backupPath)]);
  assert.deepEqual((await ledgerEntries(fixture, 'preparing')).length, 1, '只有第一份的准备记录');
  await releaseLargeMergePreparation(preparation);
  assert.deepEqual(await targetBackups(fixture), [], '没用上的备份删掉了');
  assert.deepEqual(await registrations(fixture), []);
  assert.deepEqual(await ledgerEntries(fixture, 'preparing'), []);
});

test('会话开始之后窗口消失：备份在第一份来源之前记为用过，清理过期准备时只撤登记，这份合并前备份照常保留', { timeout: 300_000 }, async (t) => {
  const fixture = await createConfigurationRoot();
  t.after(() => removeConfigurationRoot(fixture.root));
  await seedRichSource(fixture.alpha, 'alpha', 3);
  const killed = await runChild(t, fixture, { fault: { point: 'after-commit' } });
  assert.equal(killed.signal, 'SIGKILL', killed.stderr);
  const [backup] = await targetBackups(fixture);
  assert.ok(backup);
  const [registration] = await registrations(fixture);
  assert.equal(registration.name, backup);
  assert.equal(registration.used, true, '会话开始前记为用过');
  await withWindow(fixture, async (window) => {
    const batch = await mergeHistoricalDataSetsOnline(fixture.paths, { configurationRootPath: fixture.root, database: window }, { sizeLimits: LIMITS.sizeLimits });
    assert.equal(batch.merged.length, 1, '提交之后被杀的那份按实测收敛为已合并');
  });
  assert.deepEqual(await targetBackups(fixture), [backup], '合并前备份保留');
  assert.deepEqual(await registrations(fixture), [], '只撤登记');
});

test('会话结束时关闭私有实例出错：已合并的结果照常返回，用上的备份保留，登记撤掉', { timeout: 300_000 }, async (t) => {
  const fixture = await createConfigurationRoot();
  t.after(() => removeConfigurationRoot(fixture.root));
  await seedRichSource(fixture.alpha, 'alpha', 3);
  const close = kernel.RuntimeDatabase.prototype.close;
  let armed = false;
  let failed = 0;
  kernel.RuntimeDatabase.prototype.close = async function closeThenFail(...args) {
    await close.apply(this, args);
    if (!armed) return;
    armed = false;
    failed += 1;
    throw new Error('worker exited while closing');
  };
  t.after(() => { kernel.RuntimeDatabase.prototype.close = close; });
  const warnings = quietWarnings(t);
  const { session, preparation } = await prepareAndRun(fixture, {
    ...LIMITS,
    onFaultPoint: (point) => { if (point === 'before-merged-record') armed = true; }
  });
  assert.equal(failed, 1, '私有实例的关闭抛错了');
  assert.ok(warnings.some((line) => line.includes('关闭私有实例出错')), '记下了警告');
  assert.deepEqual(session.results.map((result) => result.state), ['merged']);
  assert.ok(session.results[0].result.insertedRows > 0);
  assert.deepEqual(await targetBackups(fixture), [path.basename(preparation.backupPath)], '用上的备份保留');
  assert.deepEqual(await registrations(fixture), []);
  assert.equal((await readLedgerRecord(fixture, preparation.sources[0].candidateId)).state, 'merged');
});

test('删除私有副本失败（Windows 上被扫描程序占着：EBUSY）不覆盖已有的结果：在线合并、准备和会话都照常给出结果，副本留在临时目录', { timeout: 300_000 }, async (t) => {
  const fixture = await createConfigurationRoot({ beta: true });
  t.after(() => removeConfigurationRoot(fixture.root));
  // alpha (77 rows) is merged online, beta (125 rows) waits for the session.
  await seedRichSource(fixture.alpha, 'alpha', 2);
  await seedRichSource(fixture.beta, 'beta', 4);
  const sizeLimits = { transactionRows: 100 };
  const rm = fsPromises.rm;
  const copies = `limcode-runtime-history-${process.pid}-`;
  let refused = 0;
  fsPromises.rm = async (target, ...rest) => {
    if (path.basename(String(target)).startsWith(copies)) {
      refused += 1;
      throw Object.assign(new Error(`EBUSY: resource busy or locked, rm '${target}'`), { code: 'EBUSY', syscall: 'rm' });
    }
    return rm(target, ...rest);
  };
  const warn = console.warn;
  console.warn = () => {};
  try {
    await withWindow(fixture, async (window) => {
      const batch = await mergeHistoricalDataSetsOnline(fixture.paths, { configurationRootPath: fixture.root, database: window }, { sizeLimits });
      assert.equal(batch.merged.length, 1, JSON.stringify(batch));
      assert.equal(batch.deferred.length, 1, JSON.stringify(batch));
    });
    const { session } = await prepareAndRun(fixture, { sizeLimits, chunkRows: 7 });
    assert.deepEqual(session.results.map((result) => result.state), ['merged']);
  } finally {
    fsPromises.rm = rm;
    console.warn = warn;
    for (const name of await fs.readdir(os.tmpdir())) {
      if (name.startsWith(copies)) await fs.rm(path.join(os.tmpdir(), name), { recursive: true, force: true });
    }
  }
  assert.ok(refused >= 3, `在线合并、准备、会话的副本都没删掉（${refused} 次）`);
});

test('会话开始前准备的备份已经不在（被清理了）：整批推迟、说明原因，不写任何东西，登记撤掉', { timeout: 300_000 }, async (t) => {
  const fixture = await createConfigurationRoot();
  t.after(() => removeConfigurationRoot(fixture.root));
  await seedRichSource(fixture.alpha, 'alpha', 3);
  const rows = countRows(fixture.current);
  const preparation = await withWindow(fixture, (window) => prepareLargeMergeSources({
    paths: fixture.paths, target: { configurationRootPath: fixture.root, database: window }, options: LIMITS
  }));
  await fs.rm(preparation.backupPath, { recursive: true, force: true });
  const session = await withRuntimeDataRootAdmission(fixture.root, () => withRuntimeMaintenance(fixture.current.binding.paths,
    () => runLargeMergeSession({ paths: fixture.paths, prepared: preparation })));
  assert.deepEqual(session.results.map((result) => [result.state, result.issue?.code]), [['deferred', 'runtime-data-set-merge-backup-missing']]);
  assert.match(session.results[0].issue.message, /备份已经不在/);
  assert.equal(countRows(fixture.current), rows, '当前库没有写入');
  assert.equal(await readLedgerRecord(fixture, preparation.sources[0].candidateId), undefined, '不入账');
  assert.deepEqual(await registrations(fixture), []);
  assert.deepEqual(await ledgerEntries(fixture, 'preparing'), []);
});

test('没用上的备份这次删不掉（EBUSY；准备交还时，或会话什么也没合并时）：登记保留（会话开始前记为用过的改回没用过），不再刷新心跳；窗口不在（进程不在或 24 小时没心跳）之后下一次清理把备份和登记一起删掉；登记指向别处的目录时只撤登记', { timeout: 300_000 }, async (t) => {
  const fixture = await createConfigurationRoot();
  t.after(() => removeConfigurationRoot(fixture.root));
  await seedRichSource(fixture.alpha, 'alpha', 3);
  const rm = fsPromises.rm;
  let backup;
  const busy = async (target, ...rest) => {
    if (backup && path.resolve(String(target)) === path.resolve(backup)) {
      throw Object.assign(new Error(`EBUSY: resource busy or locked, rm '${target}'`), { code: 'EBUSY', syscall: 'rm' });
    }
    return rm(target, ...rest);
  };
  fsPromises.rm = busy;
  try {
    await withWindow(fixture, async (window) => {
      const preparation = await prepareLargeMergeSources({ paths: fixture.paths, target: { configurationRootPath: fixture.root, database: window }, options: LIMITS });
      backup = preparation.backupPath;
      await releaseLargeMergePreparation(preparation);
    });
  } finally {
    fsPromises.rm = rm;
  }
  assert.deepEqual(await targetBackups(fixture), [path.basename(backup)], '这次没删掉');
  const [registration] = await registrations(fixture);
  assert.equal(registration?.name, path.basename(backup), '登记保留');
  // This window lives on: its registration counts as held. Once its process is gone it is pruned.
  await withWindow(fixture, (window) => mergeHistoricalDataSetsOnline(fixture.paths, { configurationRootPath: fixture.root, database: window }, { sizeLimits: LIMITS.sizeLimits }));
  assert.deepEqual(await targetBackups(fixture), [path.basename(backup)], '本窗口还在：不删');
  await rewriteRegistration(fixture, registration.name, { processId: await deadProcessId() });
  const batch = (window) => mergeHistoricalDataSetsOnline(fixture.paths, { configurationRootPath: fixture.root, database: window }, { sizeLimits: LIMITS.sizeLimits });
  // Still busy when the pruning gets to it: kept, registration and all, for the next pruning.
  fsPromises.rm = busy;
  try {
    await withWindow(fixture, batch);
  } finally {
    fsPromises.rm = rm;
  }
  assert.deepEqual(await targetBackups(fixture), [path.basename(backup)], '清理时也删不掉');
  assert.deepEqual((await registrations(fixture)).map((entry) => entry.name), [path.basename(backup)], '登记留到下一次清理');
  await withWindow(fixture, batch);
  assert.deepEqual(await targetBackups(fixture), []);
  assert.deepEqual(await registrations(fixture), []);
  // A process that is there holds it for a day after its last heartbeat at most.
  const hoursAgo = (hours) => new Date(Date.now() - hours * 60 * 60 * 1000).toISOString();
  assert.equal(isRuntimeLargeMergeTargetBackupLive({ ...registration, processId: process.pid, heartbeatAt: hoursAgo(23) }), true);
  assert.equal(isRuntimeLargeMergeTargetBackupLive({ ...registration, processId: process.pid, heartbeatAt: hoursAgo(25) }), false, '24 小时没心跳即过期');

  // A session that merged nothing (cancelled before its first source; marked used before it) and could not remove the backup.
  const preparation = await withWindow(fixture, (window) => prepareLargeMergeSources({
    paths: fixture.paths, target: { configurationRootPath: fixture.root, database: window }, options: LIMITS
  }));
  backup = preparation.backupPath;
  const cancelled = new AbortController();
  cancelled.abort();
  fsPromises.rm = busy;
  let session;
  try {
    session = await withRuntimeDataRootAdmission(fixture.root, () => withRuntimeMaintenance(fixture.current.binding.paths,
      () => runLargeMergeSession({ paths: fixture.paths, prepared: preparation, signal: cancelled.signal })));
  } finally {
    fsPromises.rm = rm;
  }
  assert.deepEqual(session.results.map((result) => [result.state, result.reason]), [['not-run', 'cancelled']]);
  const [unused] = await registrations(fixture);
  assert.deepEqual([unused?.name, unused?.used], [path.basename(backup), false], '会话什么也没合并：登记保留，改回没用过');
  await rewriteRegistration(fixture, unused.name, { processId: await deadProcessId() });
  await withWindow(fixture, batch);
  assert.deepEqual(await targetBackups(fixture), [], '窗口不在之后连同备份删掉');
  assert.deepEqual(await registrations(fixture), []);

  // A registration naming anything but a backup directory of this engine removes nothing but itself.
  const elsewhere = path.join(fixture.root, 'not-merge-backups', registration.name);
  await fs.mkdir(elsewhere, { recursive: true });
  await writeRegistration(fixture, { ...registration, backupPath: elsewhere, processId: await deadProcessId() });
  await withWindow(fixture, batch);
  assert.equal(await fs.stat(elsewhere).then((info) => info.isDirectory(), () => false), true, '别处的目录不删');
  assert.deepEqual(await registrations(fixture), [], '登记撤掉');
});

test('会话开始前记不下备份的使用（写登记遇到 ENOSPC 或 EIO）：整批推迟、说明原因，不写任何东西，没用上的备份和登记都撤掉', { timeout: 300_000 }, async (t) => {
  const fixture = await createConfigurationRoot();
  t.after(() => removeConfigurationRoot(fixture.root));
  await seedRichSource(fixture.alpha, 'alpha', 3);
  const rows = countRows(fixture.current);
  const open = fsPromises.open;
  t.after(() => { fsPromises.open = open; });
  for (const [errno, code, message] of [
    ['ENOSPC', DISK_FULL, /^磁盘空间不足：合并较大的旧聊天记录前要在 .+ 记下合并前备份的使用，这次没有合并$/u],
    ['EIO', 'runtime-data-set-merge-backup-unrecorded', /^无法记下合并前备份的使用，这次没有合并；以后启动时会再合并。$/u]
  ]) {
    const preparation = await withWindow(fixture, (window) => prepareLargeMergeSources({
      paths: fixture.paths, target: { configurationRootPath: fixture.root, database: window }, options: LIMITS
    }));
    assert.equal(preparation.sources.length, 1);
    fsPromises.open = async (file, ...rest) => {
      if (String(file).includes(`${path.sep}preparing-backups${path.sep}`)) {
        throw Object.assign(new Error(`${errno}: cannot write, open '${file}'`), { code: errno, syscall: 'open', path: String(file) });
      }
      return open(file, ...rest);
    };
    let session;
    try {
      session = await withRuntimeDataRootAdmission(fixture.root, () => withRuntimeMaintenance(fixture.current.binding.paths,
        () => runLargeMergeSession({ paths: fixture.paths, prepared: preparation })));
    } finally {
      fsPromises.open = open;
    }
    assert.deepEqual(session.results.map((result) => [result.state, result.issue?.code]), [['deferred', code]], errno);
    assert.match(session.results[0].issue.message, message);
    assert.equal(countRows(fixture.current), rows, '当前库没有写入');
    assert.equal(await readLedgerRecord(fixture, fixture.alpha.id), undefined, '不入账');
    assert.deepEqual(await targetBackups(fixture), [], '没用上的备份删掉');
    assert.deepEqual(await registrations(fixture), []);
    assert.deepEqual(await ledgerEntries(fixture, 'preparing'), []);
  }
});

// ---------------------------------------------------------------------------------------------
// Disk space (review #2 with #8, and #12).
// ---------------------------------------------------------------------------------------------

test('会话写提交证据时遇到 ENOSPC：与 SQLITE_FULL 一样按磁盘空间不足处理——中文说明和需要量、没有系统原文，这份撤回，后面的来源不再开始', { timeout: 300_000 }, async (t) => {
  // A full disk or quota anywhere in the cause chain; nothing else.
  for (const code of ['ENOSPC', 'EDQUOT', 'SQLITE_FULL']) {
    assert.equal(HISTORICAL_MERGE_ENGINE.isDiskFullError(new Error('wrapped', { cause: Object.assign(new Error(code), { code }) })), true, code);
  }
  assert.equal(HISTORICAL_MERGE_ENGINE.isDiskFullError(Object.assign(new Error('EIO'), { code: 'EIO' })), false);
  const fixture = await createConfigurationRoot({ beta: true });
  t.after(() => removeConfigurationRoot(fixture.root));
  await seedRichSource(fixture.alpha, 'alpha', 3);
  await seedRichSource(fixture.beta, 'beta', 3);
  const before = readAll(fixture.current);
  const preparation = await withWindow(fixture, (window) => prepareLargeMergeSources({
    paths: fixture.paths, target: { configurationRootPath: fixture.root, database: window }, options: LIMITS
  }));
  assert.equal(preparation.sources.length, 2);
  // From the moment the first source's evidence is completed the disk is full.
  const open = fsPromises.open;
  let full = false;
  fsPromises.open = async (file, ...rest) => {
    if (full && String(file).includes(`${path.sep}commits${path.sep}`)) {
      throw Object.assign(new Error(`ENOSPC: no space left on device, open '${file}'`), { code: 'ENOSPC', errno: -28, syscall: 'open', path: String(file) });
    }
    return open(file, ...rest);
  };
  t.after(() => { fsPromises.open = open; });
  const session = await withRuntimeDataRootAdmission(fixture.root, () => withRuntimeMaintenance(fixture.current.binding.paths,
    () => runLargeMergeSession({
      paths: fixture.paths, prepared: preparation,
      options: { onFaultPoint: (point) => { if (point === 'after-last-chunk') full = true; } }
    })));
  fsPromises.open = open;
  assert.deepEqual(session.results.map((result) => [result.state, result.issue?.code ?? result.reason]), [['deferred', DISK_FULL], ['not-run', 'disk-full']]);
  const { message } = session.results[0].issue;
  assert.match(message, /^磁盘空间不足，需要约 \d+ MB：合并这份旧聊天记录要在 .+ 暂存数据，已撤回这份的写入$/u, message);
  assert.doesNotMatch(message, /ENOSPC|no space|[A-Za-z]{6,}:/u, '没有系统原文');
  assert.deepEqual(readAll(fixture.current), before, '当前库回滚干净');
  assert.equal(await readLedgerRecord(fixture, preparation.sources[0].candidateId), undefined);
  assert.deepEqual(await ledgerEntries(fixture, 'commits'), []);
});

test('会话中途磁盘快满：每块写完查剩余空间，不到 64 MB 余量就提前回滚，按已写入的部分推算需要量；后面的来源不开始', { timeout: 300_000 }, async (t) => {
  const fixture = await createConfigurationRoot({ beta: true });
  t.after(() => removeConfigurationRoot(fixture.root));
  await seedRichSource(fixture.alpha, 'alpha', 3);
  await seedRichSource(fixture.beta, 'beta', 3);
  const before = readAll(fixture.current);
  let nearlyFull = false;
  const probed = [];
  const freeSpace = async (directory) => {
    probed.push(directory);
    return nearlyFull ? 8 * MiB : 1024 * 1024 * MiB;
  };
  // The WAL the transaction wrote so far, as the session reads it once the disk is nearly full: large
  // enough that the need projected from it over all the source's rows is above the size model.
  const wal = path.resolve(`${fixture.current.binding.paths.databasePath}-wal`);
  const walAtCheck = 40 * MiB;
  const stat = fsPromises.stat;
  fsPromises.stat = async (file, ...rest) => (nearlyFull && path.resolve(String(file)) === wal ? { size: walAtCheck } : stat(file, ...rest));
  t.after(() => { fsPromises.stat = stat; });
  const { preparation, session } = await prepareAndRun(fixture, {
    ...LIMITS, freeSpace,
    onFaultPoint: (point, detail) => { if (point === 'after-chunk' && detail.chunk === 1) nearlyFull = true; }
  });
  fsPromises.stat = stat;
  assert.deepEqual(session.results.map((result) => [result.state, result.issue?.code ?? result.reason]), [['deferred', DISK_FULL], ['not-run', 'disk-full']]);
  const { message } = session.results[0].issue;
  const match = /^磁盘空间快满了（(.+) 只剩约 8 MB）：按已写入的部分推算，合并这份旧聊天记录需要约 (\d+) MB，已提前撤回这份的写入$/u.exec(message);
  assert.ok(match, message);
  assert.equal(match[1], preparation.space.targetDirectory);
  const [source] = preparation.sources;
  const modelled = largeMergeTargetBytes([source], preparation.space.targetIndexBytes, 64 * MiB);
  assert.ok(Number(match[2]) >= Math.ceil(modelled / MiB), `${match[2]} MB，模型 ${modelled}`);
  // Two chunks of at most 7 rows were written: the WAL projected over all rows, at least.
  const projected = source.databaseBytes + (walAtCheck / (2 * LIMITS.chunkRows)) * source.rows + 64 * MiB;
  assert.ok(projected > modelled && Number(match[2]) >= Math.floor(projected / MiB), `${match[2]} MB，按预写日志推算至少 ${Math.floor(projected / MiB)} MB`);
  assert.ok(probed.filter((directory) => directory === preparation.space.targetDirectory).length >= 3, '每块写完都查了剩余空间');
  assert.deepEqual(readAll(fixture.current), before, '提前撤回，当前库不变');
  assert.equal(await readLedgerRecord(fixture, source.candidateId), undefined);
  assert.deepEqual(await ledgerEntries(fixture, 'commits'), []);
});

test('真的写满的磁盘（审查 #10：不是故障点模拟）：配置根在一个小 tmpfs 上，会话的事务在 SQLite 里遇到磁盘满——按磁盘空间不足推迟，中文说明不带系统原文，后面的来源不开始，当前库不变、没有记录和提交凭据，预写日志还给磁盘；腾出空间后再合并两份都成', { timeout: 300_000 }, async (t) => {
  if (spawnSync('unshare', ['-Urm', 'true']).status !== 0) {
    t.skip('这台机器不允许无特权的用户与挂载命名空间（unshare -Urm），挂不了小 tmpfs');
    return;
  }
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'limcode-large-merge-small-tmpfs-'));
  const temporary = await fs.mkdtemp(path.join(os.tmpdir(), 'limcode-large-merge-small-tmpfs-copies-'));
  t.after(async () => {
    await fs.rm(directory, { recursive: true, force: true });
    await fs.rm(temporary, { recursive: true, force: true });
  });
  const child = path.join(HERE, 'runtime-dataset-merge-disk-full-child.mjs');
  // The tmpfs exists only in the child's mount namespace and goes away with it.
  const result = await new Promise((resolve) => {
    execFile('unshare', ['-Urm', 'sh', '-c', 'mount -t tmpfs -o size=48m tmpfs "$1" && exec "$2" "$3" "$1"', 'sh', directory, process.execPath, child], {
      env: { ...process.env, LIMCODE_TEST_EXTENSION_ROOT: compiled, TMPDIR: temporary }, maxBuffer: 16 * 1024 * 1024
    }, (error, stdout, stderr) => resolve({ code: error ? error.code ?? null : 0, stdout, stderr }));
  });
  assert.equal(result.code, 0, result.stderr);
  const seen = JSON.parse(result.stdout);
  assert.equal(seen.prepared, 2);
  assert.deepEqual(seen.results.map((item) => [item.state, item.code ?? item.reason]), [['deferred', DISK_FULL], ['not-run', 'disk-full']], JSON.stringify(seen.results));
  const [, where] = /^磁盘空间不足，需要约 \d+ MB：合并这份旧聊天记录要在 (\S+) 暂存数据，已撤回这份的写入/.exec(seen.results[0].message) ?? [];
  assert.ok(where?.startsWith(directory), seen.results[0].message);
  assert.doesNotMatch(seen.results[0].message.replace(where, ''), /SQLITE|disk|full|ENOSPC|space left/i, '没有系统原文');
  assert.equal(seen.unchanged, true, '当前库不变');
  assert.equal(seen.walAfter, 0, '撤回的事务的预写日志还给了磁盘');
  assert.deepEqual([seen.records, seen.commits], [[null, null], []]);
  assert.deepEqual(seen.again, ['merged', 'merged'], '腾出空间后两份都合并');
});

test('会话里一份来源撤回之后（它的事务已把页溢出写进预写日志），下一份开始之前预写日志已还给磁盘；下一份照常合并', { timeout: 300_000 }, async (t) => {
  const fixture = await createConfigurationRoot({ beta: true });
  t.after(() => removeConfigurationRoot(fixture.root));
  const { generateSyntheticSource } = await import('./fixtures/runtime-merge-fixture.mjs');
  // Large enough that the transaction's pages spill out of the maintenance writer's 4 MiB page cache into the WAL.
  await generateSyntheticSource(fixture.alpha, { rows: 50_000, prefix: 'synthetic' });
  await seedRichSource(fixture.beta, 'beta', 3);
  const wal = `${fixture.current.binding.paths.databasePath}-wal`;
  const walBytes = () => fs.stat(wal).then((info) => info.size, () => 0);
  const preparation = await withWindow(fixture, (window) => prepareLargeMergeSources({
    paths: fixture.paths, target: { configurationRootPath: fixture.root, database: window }, options: { sizeLimits: LIMITS.sizeLimits }
  }));
  assert.deepEqual(preparation.sources.map((source) => source.candidateId), [fixture.alpha.id, fixture.beta.id]);
  const seen = {};
  const session = await withRuntimeDataRootAdmission(fixture.root, () => withRuntimeMaintenance(fixture.current.binding.paths,
    () => runLargeMergeSession({
      paths: fixture.paths, prepared: preparation,
      options: {
        onFaultPoint: async (point, detail = {}) => {
          if (point === 'after-last-chunk' && detail.candidateId === fixture.alpha.id) {
            seen.atFailure = await walBytes();
            throw new Error('the first source fails after its last chunk');
          }
          if (point === 'before-source' && detail.index === 1) seen.beforeNext = await walBytes();
        }
      }
    })));
  assert.deepEqual(session.results.map((result) => result.state), ['deferred', 'merged']);
  assert.ok(seen.atFailure > 4 * MiB, `撤回前预写日志 ${seen.atFailure} 字节（页溢出写进了预写日志）`);
  assert.equal(seen.beforeNext, 0, '下一份开始前已还给磁盘');
});

test('空间计入目标会被改写的索引页：准备在它的目标备份上实测（dbstat），估计按目标文件大小的 0.65 估；需要量按同一个模型', { timeout: 300_000 }, async (t) => {
  const fixture = await createConfigurationRoot();
  t.after(() => removeConfigurationRoot(fixture.root));
  await seedRichSource(fixture.current, 'target', 6);
  await seedRichSource(fixture.alpha, 'alpha', 3);
  await withWindow(fixture, async (window) => {
    const target = { configurationRootPath: fixture.root, database: window };
    const estimate = await estimateLargeMergeSources({ paths: fixture.paths, target, options: LIMITS });
    assert.equal(estimate.space.targetIndexBytes, Math.ceil(estimate.space.targetBackupBytes * 0.65));
    const preparation = await prepareLargeMergeSources({ paths: fixture.paths, target, options: LIMITS });
    try {
      const measured = await indexBytesOf(path.join(preparation.backupPath, 'limcode.sqlite'));
      assert.ok(measured > 0);
      assert.equal(preparation.space.targetIndexBytes, measured, '准备在它的备份上实测');
      const [source] = preparation.sources;
      assert.equal(preparation.space.targetBytes, Math.ceil(source.databaseBytes * 2.5 + measured + 64 * MiB));
      assert.equal(preparation.space.targetBytes, largeMergeTargetBytes([source], measured, 64 * MiB));
    } finally {
      await releaseLargeMergePreparation(preparation);
    }
  });
});

test('空间不够、开不了大库会话时，中等来源照常单独协调合并，不被连带挡住；空间够时照旧随会话一起等待', { timeout: 300_000 }, async (t) => {
  const fixture = await createConfigurationRoot({ beta: true });
  t.after(() => removeConfigurationRoot(fixture.root));
  await seedConversations(fixture.alpha, [{ id: 'alpha_medium' }]);
  await seedRichSource(fixture.beta, 'beta', 3);
  const [alphaRows, betaRows] = [countRows(fixture.alpha), countRows(fixture.beta)];
  assert.ok(alphaRows < betaRows);
  // alpha is above the online bound only (its own coordination); beta is above the in-memory bound too (a session).
  const limits = { limits: { maxRows: alphaRows - 1, maxBytes: 1024 ** 4 }, sizeLimits: { transactionRows: alphaRows } };
  const coordinated = [];
  const coordinateOversized = async (input, run) => { coordinated.push(input.candidateId ?? input); await input.withLocks(run); return { state: 'completed' }; };
  const initial = await saveState(fixture, fixture.current);
  t.after(() => initial.remove());
  const targetFiles = async () => {
    const database = fixture.current.binding.paths.databasePath;
    let bytes = 0;
    for (const file of [database, `${database}-wal`]) bytes += await fs.stat(file).then((info) => info.size, () => 0);
    return bytes;
  };
  // Room for the online merge's backup of the target (its files and the 64 MB margin), not for the session.
  const tight = async () => (await targetFiles()) + 64 * MiB + 16 * 1024;
  const cramped = await withWindow(fixture, (window) => mergeHistoricalDataSetsOnline(fixture.paths,
    { configurationRootPath: fixture.root, database: window }, { ...limits, coordinateOversized, freeSpace: tight }));
  assert.deepEqual(cramped.merged.map((item) => item.candidateId), [fixture.alpha.id], '中等来源照常合并');
  assert.deepEqual(cramped.deferred.map((issue) => [issue.candidateId, issue.code]), [[fixture.beta.id, RUNTIME_DATA_SET_MERGE_AWAITING_EXCLUSIVE]]);
  assert.equal(coordinated.length, 1, '单独协调了一次');
  await initial.restore();

  const roomy = await withWindow(fixture, (window) => mergeHistoricalDataSetsOnline(fixture.paths,
    { configurationRootPath: fixture.root, database: window }, { ...limits, coordinateOversized, freeSpace: async () => 1024 * 1024 * MiB }));
  assert.deepEqual(roomy.merged, []);
  assert.deepEqual(roomy.deferred.map((issue) => [issue.candidateId, issue.code]).sort(),
    [[fixture.alpha.id, RUNTIME_DATA_SET_MERGE_AWAITING_EXCLUSIVE], [fixture.beta.id, RUNTIME_DATA_SET_MERGE_AWAITING_EXCLUSIVE]].sort());
  assert.equal(coordinated.length, 1, '空间够时中等来源随会话等待，不单独协调');

  // Room for the session's target side, not for the private copy of its source on the same disk (the temporary directory).
  const [rootDevice, temporaryDevice] = await Promise.all([fixture.root, os.tmpdir()].map(async (directory) => (await fs.stat(directory)).dev));
  if (rootDevice === temporaryDevice) {
    await initial.restore();
    const betaBytes = cramped.deferred[0].size?.bytes;
    assert.ok(betaBytes > 0, JSON.stringify(cramped.deferred[0]));
    const targetSideOnly = async () => {
      const files = await targetFiles();
      return files + largeMergeTargetBytes([{ databaseBytes: betaBytes }], estimatedTargetIndexBytes(files), 64 * MiB) + MiB;
    };
    const copyTooMuch = await withWindow(fixture, (window) => mergeHistoricalDataSetsOnline(fixture.paths,
      { configurationRootPath: fixture.root, database: window }, { ...limits, coordinateOversized, freeSpace: targetSideOnly }));
    assert.deepEqual(copyTooMuch.merged.map((item) => item.candidateId), [fixture.alpha.id], '放不下来源的私有副本：中等来源照常合并');
    assert.equal(coordinated.length, 2);
  }
});

test('准备时写不下目标备份或正文对象（ENOSPC）：这份推迟为磁盘空间不足（中文、写明写不下的目录、没有系统原文），后面的来源也不开始准备，不留备份和登记', { timeout: 300_000 }, async (t) => {
  const fixture = await createConfigurationRoot({ beta: true });
  t.after(() => removeConfigurationRoot(fixture.root));
  await seedRichSource(fixture.alpha, 'alpha', 3);
  await seedRichSource(fixture.beta, 'beta', 3);
  const open = fsPromises.open;
  fsPromises.open = async (file, ...rest) => {
    if (String(file).includes(`${path.sep}merge-backups${path.sep}`) && String(file).endsWith('.tmp')) {
      throw Object.assign(new Error(`ENOSPC: no space left on device, open '${file}'`), { code: 'ENOSPC', errno: -28, syscall: 'open', path: String(file) });
    }
    return open(file, ...rest);
  };
  t.after(() => { fsPromises.open = open; });
  const preparation = await withWindow(fixture, (window) => prepareLargeMergeSources({
    paths: fixture.paths, target: { configurationRootPath: fixture.root, database: window }, options: LIMITS
  }));
  fsPromises.open = open;
  assert.deepEqual(preparation.sources, []);
  const [first, second] = preparation.report.deferred;
  assert.deepEqual([first?.code, second?.code, preparation.report.deferred.length], [DISK_FULL, DISK_FULL, 2], JSON.stringify(preparation.report));
  assert.match(first.message, /^磁盘空间不足：合并前要在 .+ 备份当前历史库，写不下了；腾出空间后会再合并/u, first.message);
  assert.equal(second.message, '前一份准备时磁盘空间不足，这一份没有开始；腾出空间后会再合并。');
  for (const issue of [first, second]) assert.doesNotMatch(issue.message, /ENOSPC|no space/u);
  assert.deepEqual(await targetBackups(fixture), []);
  assert.deepEqual(await registrations(fixture), []);
  assert.deepEqual(await ledgerEntries(fixture, 'preparing'), []);

  // The same once the backup is there and the target's content store is full: said with the directory
  // written to (a link names the source object as its path, the target as its dest).
  const linkedTo = [];
  const noRoomToLink = async (from, to) => {
    linkedTo.push(to);
    throw Object.assign(new Error(`ENOSPC: no space left on device, link '${from}' -> '${to}'`), { code: 'ENOSPC', errno: -28, syscall: 'link', path: from, dest: to });
  };
  const linking = await withWindow(fixture, (window) => prepareLargeMergeSources({
    paths: fixture.paths, target: { configurationRootPath: fixture.root, database: window }, options: { ...LIMITS, linkFile: noRoomToLink }
  }));
  assert.deepEqual(linking.sources, []);
  assert.deepEqual(linking.report.deferred.map((issue) => issue.code), [DISK_FULL, DISK_FULL], JSON.stringify(linking.report));
  assert.equal(linkedTo.length, 1, '第一个正文对象就写不下，后面的来源不开始');
  assert.equal(linking.report.deferred[0].message, `磁盘空间不足：复制正文文件时在 ${path.dirname(linkedTo[0])} 写不下了；腾出空间后会再合并`);
  assert.deepEqual(await targetBackups(fixture), [], '这次的备份也删掉');
  assert.deepEqual(await registrations(fixture), []);
  assert.deepEqual(await ledgerEntries(fixture, 'preparing'), []);

  // And when the temporary directory has no room for the private copy of the source (its copy names the copy as dest).
  const copyFile = fsPromises.copyFile;
  fsPromises.copyFile = async (from, to, ...rest) => {
    if (path.basename(path.dirname(String(to))).startsWith(`limcode-runtime-history-${process.pid}-`)) {
      throw Object.assign(new Error(`ENOSPC: no space left on device, copyfile '${from}' -> '${to}'`), { code: 'ENOSPC', errno: -28, syscall: 'copyfile', path: String(from), dest: String(to) });
    }
    return copyFile(from, to, ...rest);
  };
  let copying;
  try {
    copying = await withWindow(fixture, (window) => prepareLargeMergeSources({
      paths: fixture.paths, target: { configurationRootPath: fixture.root, database: window }, options: LIMITS
    }));
  } finally {
    fsPromises.copyFile = copyFile;
  }
  assert.deepEqual(copying.report.deferred.map((issue) => issue.code), [DISK_FULL, DISK_FULL], JSON.stringify(copying.report));
  const [, temporary] = /^磁盘空间不足：准备合并这份旧聊天记录时在 (.+) 写不下了，这次没有合并；腾出空间后会再合并$/u.exec(copying.report.deferred[0].message) ?? [];
  assert.equal(path.dirname(temporary ?? ''), os.tmpdir(), copying.report.deferred[0].message);
  assert.match(path.basename(temporary), new RegExp(`^limcode-runtime-history-${process.pid}-`));
  assert.deepEqual(await targetBackups(fixture), []);
  assert.deepEqual(await ledgerEntries(fixture, 'preparing'), []);
});

// ---------------------------------------------------------------------------------------------
// Memory (review #3): the CAS verification cache when its file cannot be used.
// ---------------------------------------------------------------------------------------------

test('正文核验缓存文件损坏（不是数据库）：打开时删掉重建，之后照常记在盘上', { timeout: 120_000 }, async (t) => {
  const fixture = await createConfigurationRoot();
  t.after(() => removeConfigurationRoot(fixture.root));
  const file = path.join(resolveVscodeRuntimeMergeLedgerRoot(fixture.paths), 'limcode.cas-verified.sqlite');
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file, 'this is not a database, only garbage left behind '.repeat(200));
  const cache = await openRuntimeCasVerificationCache(fixture.root);
  cache.set('/cas/sha256/aa/object', '1:2:3:4:5');
  cache.close();
  const again = await openRuntimeCasVerificationCache(fixture.root);
  try {
    assert.equal(again.get('/cas/sha256/aa/object'), '1:2:3:4:5', '重建之后记在盘上');
    assert.equal(again.unrecorded(), 0);
  } finally {
    again.close();
  }
});

test('正文核验缓存用不了时（它的位置被一个目录占着）：内存里最多留 1 万条，多的不留并计数；准备因此如实推迟这份来源，不进会话，也不留备份和声明', { timeout: 300_000 }, async (t) => {
  const fixture = await createConfigurationRoot();
  t.after(() => removeConfigurationRoot(fixture.root));
  const file = path.join(resolveVscodeRuntimeMergeLedgerRoot(fixture.paths), 'limcode.cas-verified.sqlite');
  await fs.mkdir(file, { recursive: true });
  const cache = await openRuntimeCasVerificationCache(fixture.root);
  try {
    for (let index = 0; index < 10_050; index += 1) cache.set(`/cas/${index}`, `identity-${index}`);
    assert.equal(cache.unrecorded(), 50, '超过 1 万条的不留');
    assert.equal(cache.get('/cas/9999'), 'identity-9999');
    assert.equal(cache.get('/cas/10000'), undefined);
    cache.delete('/cas/0');
    assert.equal(cache.get('/cas/0'), undefined);
  } finally {
    cache.close();
  }

  // A source with more objects than that: its preparation says so instead of leaving them to the session.
  await contentHeavySource(fixture.alpha, 920);
  const preparation = await withWindow(fixture, (window) => prepareLargeMergeSources({
    paths: fixture.paths, target: { configurationRootPath: fixture.root, database: window }, options: { sizeLimits: { transactionRows: 1_000 } }
  }));
  assert.deepEqual(preparation.sources, []);
  assert.deepEqual(preparation.report.deferred.map((issue) => issue.code), ['runtime-data-set-merge-verification-unrecorded']);
  assert.match(preparation.report.deferred[0].message, /正文的核验结果没能全部记下/);
  assert.deepEqual(await targetBackups(fixture), []);
  assert.deepEqual(await registrations(fixture), []);
  assert.deepEqual(await ledgerEntries(fixture, 'preparing'), []);
  assert.equal(await readLedgerRecord(fixture, fixture.alpha.id), undefined, '不入账，以后再合并');
});

// ---------------------------------------------------------------------------------------------
// Rows the Runtime refuses (review #5) and conflicts found in the session (#9).
// ---------------------------------------------------------------------------------------------

test('不变量在试算里就查出（来源里一个已结束请求缺 Operation）：准备按受阻入账，不备份、不进会话，当前库不变；下次启动直接报告为受阻，不再等待大库会话', { timeout: 300_000 }, async (t) => {
  const fixture = await createConfigurationRoot();
  t.after(() => removeConfigurationRoot(fixture.root));
  await seedRichSource(fixture.alpha, 'alpha', 3);
  const request = 'alpha_conversation_2_request_completed';
  rawWrite(fixture.alpha, (source) => {
    source.prepare('DELETE FROM attempt WHERE id = ?').run(`${request}_attempt`);
    source.prepare('DELETE FROM operation WHERE id = ?').run(`${request}_operation`);
  });
  const before = readAll(fixture.current);
  const preparation = await withWindow(fixture, async (window) => {
    const batch = await mergeHistoricalDataSetsOnline(fixture.paths, { configurationRootPath: fixture.root, database: window }, { sizeLimits: LIMITS.sizeLimits });
    assert.deepEqual(batch.deferred.map((issue) => issue.code), [RUNTIME_DATA_SET_MERGE_AWAITING_EXCLUSIVE]);
    return prepareLargeMergeSources({ paths: fixture.paths, target: { configurationRootPath: fixture.root, database: window }, options: LIMITS });
  });
  assert.deepEqual(preparation.sources, [], '不进会话');
  assert.deepEqual(preparation.report.blocked.map((issue) => issue.code), [INVARIANT]);
  assert.match(preparation.report.blocked[0].message,
    /当前库不接受的数据[\s\S]*两边内容都没有改动[\s\S]*不再自动重试[\s\S]*ModelRequest alpha_conversation_2_request_completed must own exactly one Operation/);
  assert.equal(preparation.backupPath, undefined);
  assert.deepEqual(await targetBackups(fixture), []);
  assert.deepEqual(readAll(fixture.current), before, '当前库不变');
  const record = await readLedgerRecord(fixture, fixture.alpha.id);
  assert.deepEqual([record.state, record.code], ['blocked', INVARIANT]);

  await withWindow(fixture, async (window) => {
    const batch = await mergeHistoricalDataSetsOnline(fixture.paths, { configurationRootPath: fixture.root, database: window }, { sizeLimits: LIMITS.sizeLimits });
    assert.deepEqual(batch.deferred, [], '不再等待大库会话');
    assert.deepEqual(batch.blocked.map((issue) => [issue.code, issue.newly]), [[INVARIANT, false]], '照记下的结果报告');
    const again = await prepareLargeMergeSources({ paths: fixture.paths, target: { configurationRootPath: fixture.root, database: window }, options: LIMITS });
    assert.deepEqual(again.sources, [], '不再准备');
  });
});

test('不变量在会话里才查出（来源里一个对话的项目链接换了 id：试算只比 id，写入时撞上“每个对话一条”的唯一约束）：整份回滚，按受阻入账，下次启动不再准备', { timeout: 300_000 }, async (t) => {
  const fixture = await createConfigurationRoot();
  t.after(() => removeConfigurationRoot(fixture.root));
  await seedRichSource(fixture.alpha, 'alpha', 3);
  await withWindow(fixture, (window) => mergeHistoricalDataSetsOnline(fixture.paths, { configurationRootPath: fixture.root, database: window }));
  assert.equal((await readLedgerRecord(fixture, fixture.alpha.id)).state, 'merged');
  rawWrite(fixture.alpha, (source) => {
    source.prepare("UPDATE conversation_project_link SET id = 'alpha_relinked' WHERE conversation_id = 'alpha_conversation_1'").run();
  });
  const before = readAll(fixture.current);
  const { preparation, session } = await prepareAndRun(fixture, LIMITS, { candidateIds: [fixture.alpha.id], requested: true });
  assert.equal(preparation.sources.length, 1, '试算没有发现');
  assert.deepEqual(session.results.map((result) => [result.state, result.issue?.code]), [['blocked', INVARIANT]]);
  assert.match(session.results[0].issue.message, /当前库不接受的数据[\s\S]*UNIQUE constraint failed: conversation_project_link\.conversation_id/);
  assert.deepEqual(readAll(fixture.current), before, '整份回滚');
  const record = await readLedgerRecord(fixture, fixture.alpha.id);
  assert.deepEqual([record.state, record.code], ['blocked', INVARIANT]);
  assert.deepEqual(await ledgerEntries(fixture, 'commits'), []);

  await withWindow(fixture, async (window) => {
    const batch = await mergeHistoricalDataSetsOnline(fixture.paths, { configurationRootPath: fixture.root, database: window }, { sizeLimits: LIMITS.sizeLimits });
    assert.deepEqual(batch.deferred, [], '不再等待大库会话');
    const again = await prepareLargeMergeSources({ paths: fixture.paths, target: { configurationRootPath: fixture.root, database: window }, options: LIMITS });
    assert.deepEqual(again.sources, [], '不再准备');
  });
});

test('已有请求的新增尝试也在预检时验证：非法聚合不备份、不进入会话，按受阻入账', { timeout: 300_000 }, async (t) => {
  const fixture = await createConfigurationRoot();
  t.after(() => removeConfigurationRoot(fixture.root));
  await seedRichSource(fixture.alpha, 'alpha', 3);
  await withWindow(fixture, (window) => mergeHistoricalDataSetsOnline(fixture.paths, { configurationRootPath: fixture.root, database: window }));
  const request = 'alpha_conversation_0_request_completed';
  rawWrite(fixture.alpha, (source) => {
    source.prepare(`INSERT INTO attempt (id, operation_id, attempt_seq, status, created_at, updated_at, completed_at)
      VALUES (?, ?, 2, 'completed', ?, ?, ?)`).run(`${request}_attempt_2`, `${request}_operation`, NOW, NOW, NOW);
  });
  const before = readAll(fixture.current);
  const preparation = await withWindow(fixture, (window) => prepareLargeMergeSources({
    paths: fixture.paths, target: { configurationRootPath: fixture.root, database: window }, options: LIMITS,
    candidateIds: [fixture.alpha.id], requested: true
  }));
  assert.equal(preparation.sources.length, 0);
  assert.deepEqual(preparation.report.blocked.map((issue) => issue.code), [INVARIANT]);
  assert.equal(preparation.backupPath, undefined);
  assert.match(preparation.report.blocked[0].message, new RegExp(`ModelRequest ${request} current Attempt must be the contiguous tail`));
  assert.deepEqual(readAll(fixture.current), before, '整份回滚');
  assert.equal((await readLedgerRecord(fixture, fixture.alpha.id)).state, 'blocked');
});

test('预检通过后的最终 worker 聚合校验仍然有效：提交前多出的非法 Attempt 整份回滚', { timeout: 300_000 }, async (t) => {
  const fixture = await createConfigurationRoot();
  t.after(() => removeConfigurationRoot(fixture.root));
  await seedRichSource(fixture.alpha, 'alpha', 3);
  const before = readAll(fixture.current);
  const commit = kernel.RuntimeDatabase.prototype.maintenanceCommit;
  t.after(() => { kernel.RuntimeDatabase.prototype.maintenanceCommit = commit; });
  kernel.RuntimeDatabase.prototype.maintenanceCommit = async function injectThenCommit() {
    await this.maintenanceAppend([kernel.DOMAIN_REPOSITORIES.domain('Attempt').insertHistoricalCopy({
      id: 'injected_attempt', operation_id: 'alpha_conversation_0_request_completed_operation', attempt_seq: 2n,
      status: 'completed', created_at: NOW, updated_at: NOW, completed_at: NOW
    })]);
    return commit.call(this);
  };
  const { preparation, session } = await prepareAndRun(fixture, LIMITS);
  assert.equal(preparation.sources.length, 1);
  assert.deepEqual(session.results.map((result) => [result.state, result.issue?.code]), [['blocked', INVARIANT]]);
  assert.match(session.results[0].issue.message, /current Attempt must be the contiguous tail/);
  assert.deepEqual(readAll(fixture.current), before);
});

test('写入出错但不是数据本身的问题（本线程的错误、忙、断言当前库状态失败）：照旧推迟、不入账，以后再合并', { timeout: 300_000 }, async (t) => {
  const fixture = await createConfigurationRoot();
  t.after(() => removeConfigurationRoot(fixture.root));
  await seedRichSource(fixture.alpha, 'alpha', 3);
  const append = kernel.RuntimeDatabase.prototype.maintenanceAppend;
  t.after(() => { kernel.RuntimeDatabase.prototype.maintenanceAppend = append; });
  const failures = [
    ['runtime-data-set-merge-failed', () => new Error('RuntimeDatabase is closed.')],
    ['SQLITE_BUSY', () => new RuntimeDatabaseWorkerError({ name: 'SqliteError', message: 'database is locked', code: 'SQLITE_BUSY' })],
    ['RUNTIME_TRANSACTION_ASSERTION_FAILED', () => new RuntimeDatabaseWorkerError({ name: 'Error', message: 'Conversation row changed', code: 'RUNTIME_TRANSACTION_ASSERTION_FAILED' })]
  ];
  for (const [code, failure] of failures) {
    let calls = 0;
    kernel.RuntimeDatabase.prototype.maintenanceAppend = async function appendThenFail(...args) {
      if (++calls === 2) throw failure();
      return append.apply(this, args);
    };
    const { session } = await prepareAndRun(fixture, LIMITS);
    assert.deepEqual(session.results.map((result) => [result.state, result.issue?.code]), [['deferred', code]]);
    assert.equal(await readLedgerRecord(fixture, fixture.alpha.id), undefined, `${code}：不入账`);
  }
});

test('试算里读来源副本本身出错（SQLite 的 I/O 错误）不算数据不被接受：这份推迟，不入账', { timeout: 300_000 }, async (t) => {
  const fixture = await createConfigurationRoot();
  t.after(() => removeConfigurationRoot(fixture.root));
  await seedRichSource(fixture.alpha, 'alpha', 3);
  const SqliteDatabase = require(require.resolve('better-sqlite3', { paths: [path.join(compiled, 'backend/reliableKernel')] }));
  const prepare = SqliteDatabase.prototype.prepare;
  t.after(() => { SqliteDatabase.prototype.prepare = prepare; });
  let failed = 0;
  SqliteDatabase.prototype.prepare = function prepareOrFail(sql, ...rest) {
    if (this.readonly && sql === 'SELECT * FROM model_request WHERE id = ?') {
      failed += 1;
      throw Object.assign(new Error('disk I/O error'), { code: 'SQLITE_IOERR' });
    }
    return prepare.call(this, sql, ...rest);
  };
  const preparation = await withWindow(fixture, (window) => prepareLargeMergeSources({
    paths: fixture.paths, target: { configurationRootPath: fixture.root, database: window }, options: LIMITS
  }));
  assert.ok(failed > 0, '试算读到了请求');
  assert.deepEqual(preparation.sources, []);
  assert.deepEqual(preparation.report.blocked, []);
  assert.deepEqual(preparation.report.deferred.map((issue) => issue.code), ['SQLITE_IOERR']);
  assert.equal(await readLedgerRecord(fixture, fixture.alpha.id), undefined);
});

test('会话里发现冲突就停：回滚后不再读这份来源的其余部分，拒绝里写明“至少”几处', { timeout: 300_000 }, async (t) => {
  const fixture = await createConfigurationRoot();
  t.after(() => removeConfigurationRoot(fixture.root));
  await seedRichSource(fixture.alpha, 'alpha', 4);
  const snapshot = kernel.RuntimeDatabase.prototype.snapshot;
  let streaming = false;
  let reads = 0;
  kernel.RuntimeDatabase.prototype.snapshot = function countedSnapshot(...args) {
    if (streaming) reads += 1;
    return snapshot.apply(this, args);
  };
  t.after(() => { kernel.RuntimeDatabase.prototype.snapshot = snapshot; });
  const preparation = await withWindow(fixture, (window) => prepareLargeMergeSources({
    paths: fixture.paths, target: { configurationRootPath: fixture.root, database: window }, options: LIMITS
  }));
  // Another window, before its reload, created the first conversation here with other content.
  await seedConversations(fixture.current, [{ id: 'alpha_conversation_0', title: 'changed here meanwhile' }]);
  const before = readAll(fixture.current);
  const session = await withRuntimeDataRootAdmission(fixture.root, () => withRuntimeMaintenance(fixture.current.binding.paths,
    () => runLargeMergeSession({
      paths: fixture.paths, prepared: preparation,
      options: { onFaultPoint: (point) => { if (point === 'after-committing') streaming = true; } }
    })));
  assert.deepEqual(session.results.map((result) => [result.state, result.issue?.code]), [['blocked', 'runtime-data-set-merge-conflict']]);
  assert.match(session.results[0].issue.message, /至少有 1 处同一条记录但内容不同[\s\S]*Conversation#alpha_conversation_0 字段不同：title/);
  assert.deepEqual(readAll(fixture.current), before, '整份回滚');
  const chunks = Math.ceil(preparation.sources[0].rows / LIMITS.chunkRows);
  assert.ok(chunks >= 15, `来源约 ${chunks} 块`);
  // Measured: the chunks up to the conversations and the rolled-back rows' presence (4 of about 19 reading on).
  assert.ok(reads <= 6, `发现冲突之后不再读（会话读了 ${reads} 次当前库，整份约 ${chunks} 块）`);
});

// ---------------------------------------------------------------------------------------------
// What a merge reports as inserted (review #11).
// ---------------------------------------------------------------------------------------------

test('提交的回复丢了（事务其实已提交）：按事务自己数的新增与复用行数报出结果并记账，不用准备时试算的数（准备之后当前库又有了同样的一份对话）', { timeout: 300_000 }, async (t) => {
  const fixture = await createConfigurationRoot();
  t.after(() => removeConfigurationRoot(fixture.root));
  await seedRichSource(fixture.alpha, 'alpha', 3);
  const preparation = await withWindow(fixture, (window) => prepareLargeMergeSources({
    paths: fixture.paths, target: { configurationRootPath: fixture.root, database: window }, options: LIMITS
  }));
  // Another window, before its reload, created one of the source's conversations here exactly as the source has it.
  await seedConversations(fixture.current, [{ id: 'alpha_conversation_0' }]);
  const before = countRows(fixture.current);
  const commit = kernel.RuntimeDatabase.prototype.maintenanceCommit;
  let lost = 0;
  kernel.RuntimeDatabase.prototype.maintenanceCommit = async function commitThenLoseReply(...args) {
    await commit.apply(this, args);
    lost += 1;
    throw new Error('the reply of the commit was lost');
  };
  t.after(() => { kernel.RuntimeDatabase.prototype.maintenanceCommit = commit; });
  const session = await withRuntimeDataRootAdmission(fixture.root, () => withRuntimeMaintenance(fixture.current.binding.paths,
    () => runLargeMergeSession({ paths: fixture.paths, prepared: preparation })));
  kernel.RuntimeDatabase.prototype.maintenanceCommit = commit;
  assert.equal(lost, 1);
  const inserted = countRows(fixture.current) - before;
  assert.ok(inserted < preparation.sources[0].insertRows, `会话插入的（${inserted}）比试算时少（${preparation.sources[0].insertRows}）`);
  assert.deepEqual(session.results.map((result) => [result.state, result.result?.insertedRows]), [['merged', inserted]]);
  assert.equal((await readLedgerRecord(fixture, fixture.alpha.id)).insertedRows, inserted);
});

// ---------------------------------------------------------------------------------------------
// The left-out closure off the window's thread (review #7).
// ---------------------------------------------------------------------------------------------

test('跳过闭包不长时间占着窗口线程：只读一张表的规则按 rowid 分段（每段 64 块），跨几张表的“全部成员”规则按候选分步（盲审 #4），每段、每步之后都让出线程；结果与一次跑完相同，删掉的对话（行在后面的段里）不会被插回', { timeout: 300_000 }, async (t) => {
  const fixture = await createConfigurationRoot();
  t.after(() => removeConfigurationRoot(fixture.root));
  const { generateSyntheticSource } = await import('./fixtures/runtime-merge-fixture.mjs');
  await generateSyntheticSource(fixture.alpha, { rows: 6_000, prefix: 'synthetic' });
  const first = await prepareAndRun(fixture, LIMITS);
  assert.deepEqual(first.session.results.map((result) => result.state), ['merged']);
  // Deleted here since: its message memberships sit past the first segment of their table (448 rows with 7-row chunks).
  const deleted = 'synthetic_0000060';
  const rowsOf = () => Object.fromEntries(Object.entries(readAll(fixture.current))
    .map(([table, rows]) => [table, rows.filter((row) => row.includes(deleted)).length]).filter(([, count]) => count > 0));
  await withWindow(fixture, (window) => new ConversationDeletionControlPlane(window).delete(deleted));
  const left = rowsOf();
  assert.equal(left.conversation ?? 0, 0);
  assert.equal(left.message_part_of_conversation ?? 0, 0, '删对话时这些行删掉了');
  await seedConversations(fixture.alpha, [{ id: 'alpha_after_merge' }]);

  const SqliteDatabase = require(require.resolve('better-sqlite3', { paths: [path.join(compiled, 'backend/reliableKernel')] }));
  const prepare = SqliteDatabase.prototype.prepare;
  t.after(() => { SqliteDatabase.prototype.prepare = prepare; });
  let ticks = 0;
  let ticking = true;
  const tick = () => { ticks += 1; if (ticking) setImmediate(tick); };
  setImmediate(tick);
  const runs = [];
  SqliteDatabase.prototype.prepare = function recordClosure(sql, ...rest) {
    const statement = prepare.call(this, sql, ...rest);
    const closure = typeof sql === 'string' && !sql.includes('VALUES')
      && (sql.includes('INTO temp.limcode_merge_skip') || sql.includes('DELETE FROM temp.limcode_merge_skip_candidate'));
    if (closure) {
      const run = statement.run;
      statement.run = function recordedRun(...args) {
        // Clearing the candidates (no parameters) belongs to the step after it.
        if (args.length > 0) runs.push({ sql, segment: args.length === 2 ? args : undefined, tick: ticks });
        return run.apply(this, args);
      };
    }
    return statement;
  };
  let preparation;
  try {
    preparation = await withWindow(fixture, (window) => prepareLargeMergeSources({
      paths: fixture.paths, target: { configurationRootPath: fixture.root, database: window },
      candidateIds: [fixture.alpha.id], requested: true, options: LIMITS
    }));
  } finally {
    SqliteDatabase.prototype.prepare = prepare;
    ticking = false;
  }
  assert.equal(preparation.sources.length, 1);
  assert.equal(preparation.sources[0].skippedConversations, 1);
  assert.ok(runs.length > 20, `闭包跑了 ${runs.length} 次语句（空表的规则不跑）`);
  assert.ok(runs.every((entry) => entry.segment), '每条都是一段或一步');
  const scans = runs.filter((entry) => /AS t NOT INDEXED WHERE[\s\S]* AND t\.rowid > \? AND t\.rowid <= \?\)?$/.test(entry.sql));
  const candidates = runs.filter((entry) => /ORDER BY id LIMIT \?\) AS page JOIN/.test(entry.sql)
    || /temp\.limcode_merge_skip_candidate (AS c )?WHERE (c\.)?rowid > \? AND (c\.)?rowid <= \?/.test(entry.sql));
  assert.equal(scans.length + candidates.length, runs.length, runs.filter((entry) => !scans.includes(entry) && !candidates.includes(entry)).map((entry) => entry.sql).join('\n'));
  assert.ok(scans.some((entry) => entry.segment[0] >= LIMITS.chunkRows * 64), '大的表分成了几段');
  assert.ok(candidates.some((entry) => /'Message', owner FROM temp\.limcode_merge_skip_candidate/.test(entry.sql)), '跨几张表的规则也分步跑');
  assert.ok(runs.every((entry) => !/GROUP BY/.test(entry.sql)), '没有整条跑的 GROUP BY');
  for (let index = 1; index < runs.length; index += 1) {
    assert.ok(runs[index].tick > runs[index - 1].tick, `第 ${index} 条之前让出过线程`);
  }

  const session = await withRuntimeDataRootAdmission(fixture.root, () => withRuntimeMaintenance(fixture.current.binding.paths,
    () => runLargeMergeSession({ paths: fixture.paths, prepared: preparation })));
  assert.deepEqual(session.results.map((result) => [result.state, result.result?.insertedConversations]), [['merged', 1]]);
  assert.deepEqual(rowsOf(), left, '删掉的对话一行也没有插回（它在后面段里的行也跳过了）');
  const target = new Database(fixture.current.binding.paths.databasePath, { readonly: true });
  try {
    assert.equal(target.prepare('SELECT COUNT(*) FROM conversation WHERE id = ?').pluck().get('alpha_after_merge'), 1);
  } finally { target.close(); }
});

// ---------------------------------------------------------------------------------------------
// Helpers.
// ---------------------------------------------------------------------------------------------

/** Per conversation ten distinct message bodies and a distinct request recipe (eleven content objects). */
async function contentHeavySource(dataSet, count) {
  const { MESSAGE_TYPE, modelRequestAggregate, NOW, repo, withRuntime } = await import('./fixtures/runtime-merge-fixture.mjs');
  await withRuntime(dataSet, async (runtime, store) => {
    let steps = [];
    for (let c = 0; c < count; c += 1) {
      const id = `heavy_${String(c).padStart(6, '0')}`;
      const turnId = `${id}_turn`;
      const objects = await store.prepareBatch(runtime, [
        ...Array.from({ length: 10 }, (_, m) => ({ content: JSON.stringify({ role: 'user', parts: [{ text: `${id} ${m}` }] }), contentType: MESSAGE_TYPE })),
        { content: JSON.stringify({ recipe: id }), contentType: 'application/json' }
      ]);
      for (const object of objects) if (object.insert) steps.push(object.insert);
      const ids = objects.map((object) => object.metadata.id);
      steps.push(
        repo('Conversation').insert({ id, title: id, status: 'active', created_at: NOW, updated_at: NOW }),
        repo('Turn').insert({ id: turnId, conversation_id: id, status: 'terminated', created_at: NOW, updated_at: NOW, terminal_at: NOW }),
        repo('TurnTermination').insert({ id: `${id}_termination`, turn_id: turnId, terminal_status: 'completed', reason: 'fixture', created_at: NOW })
      );
      for (let m = 0; m < 10; m += 1) {
        const messageId = `${id}_m${m}`;
        steps.push(
          repo('Message').insert({ id: messageId, created_at: NOW, updated_at: NOW, deleted_at: null }),
          repo('MessageRevision').insert({ id: `${messageId}_r`, message_id: messageId, revision_seq: 1n, role: 'user', content_object_id: ids[m], created_at: NOW }),
          repo('MessageCurrentRevisionLink').insert({ id: `${messageId}_c`, message_id: messageId, revision_id: `${messageId}_r`, updated_at: NOW }),
          repo('MessagePartOfConversation').insert({ id: `${messageId}_p`, conversation_id: id, message_id: messageId, message_seq: BigInt(m + 1), created_at: NOW })
        );
      }
      for (let r = 0; r < 4; r += 1) steps.push(...modelRequestAggregate(turnId, `${id}_q${r}`, BigInt(r + 1), { recipe: ids[10], body: ids[r], checkpoints: 1, completed: true }));
      if (steps.length >= 2_000 || c === count - 1) {
        await runtime.transaction(steps);
        steps = [];
      }
    }
  });
}

/** Index pages of a database file (dbstat), read from a private copy so the file itself gets no sidecars. */
async function indexBytesOf(file) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'limcode-large-merge-review-index-'));
  try {
    const copy = path.join(directory, 'copy.sqlite');
    await fs.copyFile(file, copy);
    const database = new Database(copy, { readonly: true });
    try {
      return Number(database.prepare(`SELECT COALESCE(SUM(page.pgsize), 0) FROM dbstat AS page
        JOIN sqlite_schema AS entry ON entry.name = page.name WHERE entry.type = 'index'`).pluck().get());
    } finally { database.close(); }
  } finally {
    await fs.rm(directory, { recursive: true, force: true });
  }
}

/** console.warn collected (not printed) for the rest of the test. */
function quietWarnings(t) {
  const lines = [];
  const warn = console.warn;
  console.warn = (...args) => { lines.push(args.map(String).join(' ')); };
  t.after(() => { console.warn = warn; });
  return lines;
}

async function rewriteRegistration(fixture, name, patch) {
  const file = path.join(resolveVscodeRuntimeMergeLedgerRoot(fixture.paths), 'preparing-backups', `${name}.json`);
  await fs.writeFile(file, JSON.stringify({ ...JSON.parse(await fs.readFile(file, 'utf8')), ...patch }));
}

/** The id of a process that has exited (and is not reused within this test). */
async function deadProcessId() {
  const child = await new Promise((resolve) => {
    const started = execFile(process.execPath, ['-e', '0'], () => resolve(started));
  });
  return child.pid;
}

function backupsDirectory(fixture) {
  return path.join(path.dirname(fixture.current.binding.paths.dataRootPath), 'merge-backups');
}

/** The same, synchronously (from a progress callback). */
function backupNamesNow(fixture) {
  try { return fsSync.readdirSync(backupsDirectory(fixture)).sort(); } catch { return []; }
}

async function writeRegistration(fixture, registration) {
  const directory = path.join(resolveVscodeRuntimeMergeLedgerRoot(fixture.paths), 'preparing-backups');
  await fs.mkdir(directory, { recursive: true });
  await fs.writeFile(path.join(directory, `${registration.name}.json`), JSON.stringify(registration));
}

async function targetBackups(fixture) {
  return (await fs.readdir(backupsDirectory(fixture)).catch(() => [])).sort();
}

async function registrations(fixture) {
  const directory = path.join(resolveVscodeRuntimeMergeLedgerRoot(fixture.paths), 'preparing-backups');
  const names = (await fs.readdir(directory).catch(() => [])).filter((name) => name.endsWith('.json')).sort();
  return Promise.all(names.map(async (name) => JSON.parse(await fs.readFile(path.join(directory, name), 'utf8'))));
}

async function withWindow(fixture, run) {
  const window = await kernel.RuntimeDatabase.open(fixture.current.authority, { hostBootId: `window-${randomUUID()}` });
  try { return await run(window); } finally { await window.close(); }
}

/** A window prepares online, closes its Runtime and runs the session inside admission and target maintenance. */
async function prepareAndRun(fixture, options, prepareInput = {}) {
  const preparation = await withWindow(fixture, (window) => prepareLargeMergeSources({
    paths: fixture.paths, target: { configurationRootPath: fixture.root, database: window }, options, ...prepareInput
  }));
  const session = await withRuntimeDataRootAdmission(fixture.root, () => withRuntimeMaintenance(fixture.current.binding.paths,
    () => runLargeMergeSession({ paths: fixture.paths, prepared: preparation })));
  return { preparation, session };
}

/** The session child (runtime-dataset-merge-streamed-child.mjs), with its own temporary directory. */
async function runChild(t, fixture, input) {
  const temporary = await fs.mkdtemp(path.join(os.tmpdir(), 'limcode-large-merge-review-child-'));
  t.after(() => fs.rm(temporary, { recursive: true, force: true }));
  const script = path.join(HERE, 'runtime-dataset-merge-streamed-child.mjs');
  return new Promise((resolve) => {
    execFile(process.execPath, [script, fixture.root, JSON.stringify({ ...LIMITS, ...input })], {
      env: { ...process.env, LIMCODE_TEST_EXTENSION_ROOT: compiled, TMPDIR: temporary },
      maxBuffer: 16 * 1024 * 1024
    }, (error, stdout, stderr) => resolve({ signal: error?.signal ?? null, code: error ? error.code ?? null : 0, stdout, stderr }));
  });
}

