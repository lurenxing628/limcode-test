// Large-merge session after its review (second part): target backups that outlive their window,
// cleanup failures that must not undo an outcome, disk space, invariants, conflicts, the closure.
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { createRequire } from 'node:module';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import {
  compiled, countRows, createConfigurationRoot, Database, kernel, kernelFile, ledgerEntries, readAll, readLedgerRecord, saveState,
  seedConversations, seedRichSource
} from './fixtures/runtime-merge-fixture.mjs';

const require = createRequire(import.meta.url);
const fsPromises = require('node:fs/promises');
const { mergeHistoricalDataSetsOnline, RUNTIME_DATA_SET_MERGE_AWAITING_EXCLUSIVE } = kernelFile('runtimeDataSetMerge.js');
const {
  estimateLargeMergeSources, prepareLargeMergeSources, releaseLargeMergePreparation, runLargeMergeSession
} = kernelFile('runtimeDataSetStreamedMerge.js');
const { largeMergeTargetBytes } = kernelFile('runtimeDataSetLargeMergeSpace.js');
const { openRuntimeCasVerificationCache } = kernelFile('runtimeCasVerificationCache.js');
const { withRuntimeDataRootAdmission, withRuntimeMaintenance } = kernelFile('runtimeHostControl.js');
const { resolveVscodeRuntimeMergeLedgerRoot } = kernelFile('vscodeRootAuthority.js');
const HERE = path.dirname(fileURLToPath(import.meta.url));
const LIMITS = { sizeLimits: { transactionRows: 50 }, chunkRows: 7 };
const MiB = 1024 * 1024;
const DISK_FULL = 'runtime-data-set-merge-disk-full';

// ---------------------------------------------------------------------------------------------
// Target backups (review #1) and failures while cleaning up (#13, #14).
// ---------------------------------------------------------------------------------------------

test('准备好的窗口在会话之前消失（关窗、重载、崩溃）：它做的目标备份登记在盘上，下一次批次或准备清理过期准备时连同备份删掉，不会一次次累积', { timeout: 300_000 }, async (t) => {
  const fixture = await createConfigurationRoot();
  t.after(() => fs.rm(fixture.root, { recursive: true, force: true }));
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
    const again = await prepareLargeMergeSources({ paths: fixture.paths, target: { configurationRootPath: fixture.root, database: window }, options: LIMITS });
    assert.equal(again.sources.length, 1, '死掉窗口的准备记录可以接手');
    assert.deepEqual(await targetBackups(fixture), [path.basename(again.backupPath)], '只剩这次准备自己的备份');
    assert.deepEqual((await registrations(fixture)).map((entry) => entry.name), [path.basename(again.backupPath)]);
    await releaseLargeMergePreparation(again);
  });
  assert.deepEqual(await targetBackups(fixture), []);
  assert.deepEqual(await registrations(fixture), [], '释放时登记也撤掉');
});

test('准备抛错时（写第二份来源的准备记录遇到 ENOSPC）：本次做的目标备份和它的登记都删掉，声明也都交还', { timeout: 300_000 }, async (t) => {
  const fixture = await createConfigurationRoot({ beta: true });
  t.after(() => fs.rm(fixture.root, { recursive: true, force: true }));
  await seedRichSource(fixture.alpha, 'alpha', 3);
  await seedRichSource(fixture.beta, 'beta', 3);
  const open = fsPromises.open;
  let claims = 0;
  fsPromises.open = async (file, ...rest) => {
    if (String(file).includes(`${path.sep}preparing${path.sep}`) && String(file).endsWith('.tmp') && ++claims === 2) {
      throw Object.assign(new Error(`ENOSPC: no space left on device, open '${file}'`), { code: 'ENOSPC', syscall: 'open' });
    }
    return open(file, ...rest);
  };
  try {
    await withWindow(fixture, async (window) => {
      await assert.rejects(prepareLargeMergeSources({
        paths: fixture.paths, target: { configurationRootPath: fixture.root, database: window }, options: LIMITS
      }), { code: 'ENOSPC' });
    });
  } finally {
    fsPromises.open = open;
  }
  assert.equal(claims >= 2, true, '第二份来源的准备记录写失败了');
  assert.deepEqual(await targetBackups(fixture), [], '第一份来源时做的备份删掉了');
  assert.deepEqual(await registrations(fixture), []);
  assert.deepEqual(await ledgerEntries(fixture, 'preparing'), []);
});

test('会话开始之后窗口消失：备份在第一份来源之前记为用过，清理过期准备时只撤登记，这份合并前备份照常保留', { timeout: 300_000 }, async (t) => {
  const fixture = await createConfigurationRoot();
  t.after(() => fs.rm(fixture.root, { recursive: true, force: true }));
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
  t.after(() => fs.rm(fixture.root, { recursive: true, force: true }));
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
  t.after(() => fs.rm(fixture.root, { recursive: true, force: true }));
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
  t.after(() => fs.rm(fixture.root, { recursive: true, force: true }));
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

test('没用上的备份这次删不掉（EBUSY）：登记保留，不再刷新心跳；窗口不在之后下一次清理把备份和登记一起删掉', { timeout: 300_000 }, async (t) => {
  const fixture = await createConfigurationRoot();
  t.after(() => fs.rm(fixture.root, { recursive: true, force: true }));
  await seedRichSource(fixture.alpha, 'alpha', 3);
  const rm = fsPromises.rm;
  let backup;
  fsPromises.rm = async (target, ...rest) => {
    if (backup && path.resolve(String(target)) === path.resolve(backup)) {
      throw Object.assign(new Error(`EBUSY: resource busy or locked, rm '${target}'`), { code: 'EBUSY', syscall: 'rm' });
    }
    return rm(target, ...rest);
  };
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
  await withWindow(fixture, (window) => mergeHistoricalDataSetsOnline(fixture.paths, { configurationRootPath: fixture.root, database: window }, { sizeLimits: LIMITS.sizeLimits }));
  assert.deepEqual(await targetBackups(fixture), []);
  assert.deepEqual(await registrations(fixture), []);
});

// ---------------------------------------------------------------------------------------------
// Disk space (review #2 with #8, and #12).
// ---------------------------------------------------------------------------------------------

test('会话写提交证据时遇到 ENOSPC：与 SQLITE_FULL 一样按磁盘空间不足处理——中文说明和需要量、没有系统原文，这份撤回，后面的来源不再开始', { timeout: 300_000 }, async (t) => {
  const fixture = await createConfigurationRoot({ beta: true });
  t.after(() => fs.rm(fixture.root, { recursive: true, force: true }));
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
  t.after(() => fs.rm(fixture.root, { recursive: true, force: true }));
  await seedRichSource(fixture.alpha, 'alpha', 3);
  await seedRichSource(fixture.beta, 'beta', 3);
  const before = readAll(fixture.current);
  let nearlyFull = false;
  const probed = [];
  const freeSpace = async (directory) => {
    probed.push(directory);
    return nearlyFull ? 8 * MiB : 1024 * 1024 * MiB;
  };
  const { preparation, session } = await prepareAndRun(fixture, {
    ...LIMITS, freeSpace,
    onFaultPoint: (point, detail) => { if (point === 'after-chunk' && detail.chunk === 1) nearlyFull = true; }
  });
  assert.deepEqual(session.results.map((result) => [result.state, result.issue?.code ?? result.reason]), [['deferred', DISK_FULL], ['not-run', 'disk-full']]);
  const { message } = session.results[0].issue;
  const match = /^磁盘空间快满了（(.+) 只剩约 8 MB）：按已写入的部分推算，合并这份旧聊天记录需要约 (\d+) MB，已提前撤回这份的写入$/u.exec(message);
  assert.ok(match, message);
  assert.equal(match[1], preparation.space.targetDirectory);
  const [source] = preparation.sources;
  const modelled = largeMergeTargetBytes([source], preparation.space.targetIndexBytes, 64 * MiB);
  assert.ok(Number(match[2]) >= Math.ceil(modelled / MiB), `${match[2]} MB，模型 ${modelled}`);
  assert.ok(probed.filter((directory) => directory === preparation.space.targetDirectory).length >= 3, '每块写完都查了剩余空间');
  assert.deepEqual(readAll(fixture.current), before, '提前撤回，当前库不变');
  assert.equal(await readLedgerRecord(fixture, source.candidateId), undefined);
  assert.deepEqual(await ledgerEntries(fixture, 'commits'), []);
});

test('空间计入目标会被改写的索引页：准备在它的目标备份上实测（dbstat），估计按目标文件大小的 0.65 估；需要量按同一个模型', { timeout: 300_000 }, async (t) => {
  const fixture = await createConfigurationRoot();
  t.after(() => fs.rm(fixture.root, { recursive: true, force: true }));
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
  t.after(() => fs.rm(fixture.root, { recursive: true, force: true }));
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
});

test('准备时写不下目标备份（ENOSPC）：这份推迟为磁盘空间不足（中文、没有系统原文），后面的来源也不开始准备，不留备份和登记', { timeout: 300_000 }, async (t) => {
  const fixture = await createConfigurationRoot({ beta: true });
  t.after(() => fs.rm(fixture.root, { recursive: true, force: true }));
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
});

// ---------------------------------------------------------------------------------------------
// Memory (review #3): the CAS verification cache when its file cannot be used.
// ---------------------------------------------------------------------------------------------

test('正文核验缓存文件损坏（不是数据库）：打开时删掉重建，之后照常记在盘上', { timeout: 120_000 }, async (t) => {
  const fixture = await createConfigurationRoot();
  t.after(() => fs.rm(fixture.root, { recursive: true, force: true }));
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
  t.after(() => fs.rm(fixture.root, { recursive: true, force: true }));
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

