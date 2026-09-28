import assert from 'node:assert/strict';
import fsSync from 'node:fs';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import vm from 'node:vm';
import { createRequire } from 'node:module';
import test from 'node:test';

/**
 * 大库会话 (vscode/commands/largeHistoricalMerge.ts): the startup prompt in one window, its 60 s
 * countdown whose “取消” only moves it to the next startup, the manual entry, the disk space check,
 * the coordination as the data-directory migration does it (the real VS Code layer and primitive
 * with real claims), the exclusive phase (this window's Runtime closed first, a cancel rolls back
 * only the source that runs, progress throttled) and the result kept across the reload. The merge
 * engine is a fake behind the adapter's interface (runtimeLargeMergeEngine.ts); the adapter's own
 * mapping is tested here, and the real engine end to end in large-historical-merge-e2e.test.mjs.
 */
const require = createRequire(import.meta.url);
const compiled = process.env.LIMCODE_TEST_EXTENSION_ROOT
  ? path.resolve(process.env.LIMCODE_TEST_EXTENSION_ROOT) : path.resolve('dist/extension');
const kernelFile = (file) => require(path.join(compiled, 'backend/reliableKernel', file));
const kernel = kernelFile('index.js');
const { RootAuthority } = kernelFile('rootAuthority.js');
const { inspectVscodeRuntimeDataSets, resolveVscodeRuntimeDataRoot } = kernelFile('vscodeRootAuthority.js');
const { summarizeRuntimeDataSet } = kernelFile('runtimeDataSetPreflight.js');
const exclusive = kernelFile('runtimeExclusiveMaintenance.js');
const { withRuntimeDataRootAdmission, withRuntimeMaintenance } = kernelFile('runtimeHostControl.js');
const engineModule = kernelFile('runtimeLargeMergeEngine.js');
const { estimateLargeMergeSources } = kernelFile('runtimeDataSetStreamedMerge.js');
const session = kernelFile('runtimeLargeMergeSession.js');
const { RuntimeWriteGate } = require(path.join(compiled, 'backend/application/reliableKernel/runtimeWriteGate.js'));
const extensionIdentity = require(path.join(compiled, 'shared/extensionIdentity.js'));
const mergeFixture = await import('./fixtures/runtime-merge-fixture.mjs');

/** Values created inside a loaded module's context compare structurally only after a copy. */
const plain = (value) => JSON.parse(JSON.stringify(value));
const MINUTE = 60_000;

// ---------------------------------------------------------------------------------------------
// The session apart from VS Code (compiled backend module).
// ---------------------------------------------------------------------------------------------

test('操作键：目标身份加各来源指纹的摘要，与来源顺序无关；来源内容变了就是新的一项工作', () => {
  const target = { dataSetId: 'target', rootInstanceId: 'instance' };
  const a = { candidateId: 'workspace:a', fingerprint: 'fa' };
  const b = { candidateId: 'workspace:b', fingerprint: 'fb' };
  const key = session.largeMergeOperationKey(target, [a, b]);
  assert.match(key, /^large-merge:target\/instance#[0-9a-f]{32}$/);
  assert.equal(session.largeMergeOperationKey(target, [b, a]), key);
  assert.notEqual(session.largeMergeOperationKey(target, [a, { ...b, fingerprint: 'fb2' }]), key);
  assert.notEqual(session.largeMergeOperationKey({ ...target, rootInstanceId: 'other' }, [a, b]), key);
});

test('空间：按引擎在会话开始时自己检查的数字核对——当前库所在的盘要引擎给出的字节数（其中已含 64 MiB 余量），临时目录要最大来源的一份、数据库临时文件目录要引擎给出的临时文件量，各再加 64 MiB；同一块盘合并核对、余量只算一次；不够时写明还差多少', async () => {
  const MiB = 1024 * 1024;
  const margin = session.LARGE_MERGE_SESSION.freeSpaceMarginBytes;
  assert.equal(margin, 64 * MiB);
  // The engine's figures: sources 900 MiB + the largest (700 MiB) × 1.5 for its WAL + 64 MiB; SQLite's temporary files a quarter of the largest.
  const facts = {
    targetDirectory: '/target', targetBytes: (900 + 1050 + 64) * MiB, temporaryDirectory: '/tmp-dir', temporaryBytes: 700 * MiB,
    sqliteTemporaryDirectory: '/var-tmp', sqliteTemporaryBytes: 175 * MiB
  };
  const disks = {
    '/target': { device: 1, freeBytes: 10_000 * MiB }, '/tmp-dir': { device: 2, freeBytes: 800 * MiB }, '/var-tmp': { device: 3, freeBytes: 300 * MiB }
  };
  const probe = async (directory) => disks[directory];
  const plan = await session.planLargeMergeSpace(facts, probe);
  assert.equal(plan.disks.find((disk) => disk.path === '/target').requiredBytes, facts.targetBytes, 'exactly what the engine checks');
  assert.equal(plan.disks.find((disk) => disk.path === '/tmp-dir').requiredBytes, 700 * MiB + margin);
  assert.equal(plan.disks.find((disk) => disk.path === '/var-tmp').requiredBytes, 175 * MiB + margin);
  assert.equal(plan.ok, true);
  // SQLite's temporary directory on its own small disk: that one is short, and said by its name.
  disks['/var-tmp'] = { device: 3, freeBytes: 200 * MiB };
  const sqliteShort = await session.planLargeMergeSpace(facts, probe);
  assert.equal(sqliteShort.ok, false);
  assert.equal(session.describeLargeMergeSpaceShortage(sqliteShort), '数据库临时文件目录（/var-tmp）剩余空间不足：需要约 239 MB，现在可用 200 MB，还差约 39 MB');
  // Both temporary directories on the target's disk: checked once, for the sum; the margin is in the engine's figure already.
  disks['/tmp-dir'] = { device: 1, freeBytes: 10_000 * MiB };
  disks['/var-tmp'] = { device: 1, freeBytes: 10_000 * MiB };
  const shared = await session.planLargeMergeSpace(facts, probe);
  assert.equal(shared.disks.length, 1);
  assert.equal(shared.disks[0].label, '当前历史库所在的盘、临时目录、数据库临时文件目录');
  assert.equal(shared.disks[0].requiredBytes, (900 + 1050 + 64 + 700 + 175) * MiB);
  // Short: not ok, and how much is missing.
  disks['/target'] = { device: 1, freeBytes: 2 * 1024 * MiB };
  const short = await session.planLargeMergeSpace(facts, probe);
  assert.equal(short.ok, false);
  assert.equal(short.disks[0].missingBytes, (900 + 1050 + 64 + 700 + 175) * MiB - 2 * 1024 * MiB);
  assert.equal(session.describeLargeMergeSpaceShortage(short),
    '当前历史库所在的盘、临时目录、数据库临时文件目录（/target）剩余空间不足：需要约 2.8 GB，现在可用 2.0 GB，还差约 841 MB');
  // Free space that cannot be read: not refused here (the engine's own check and the write decide).
  disks['/target'] = { device: 1 };
  assert.equal((await session.planLargeMergeSpace(facts, probe)).ok, true);
  // The real probe: statfs of the nearest existing directory.
  const real = await session.probeLargeMergeDisk(path.join(os.tmpdir(), 'limcode-no-such-dir', 'deeper'));
  assert.equal(typeof real.device, 'number');
  assert.ok(real.freeBytes > 0);
});

test('只有一个窗口弹提示：提示记录在配置根，同一 VS Code 会话不再提示；另一窗口的进程还在时别的会话也不提示；那个进程结束后才可接手', async (t) => {
  const { root } = await createRoot(t);
  const paths = { globalStoragePath: root };
  const alive = new Set([111, 222]);
  const classify = (processId) => (alive.has(processId) ? 'alive' : 'dead');
  const claim = (processId, sessionId) => session.claimLargeMergePrompt(paths, { sessionId, processId, classify, hostBootId: `window-${processId}` });
  assert.equal(await claim(111, 'session-A'), true, 'the first window offers it');
  assert.equal(await claim(222, 'session-B'), false, 'another window, while the first one lives');
  assert.equal(await claim(333, 'session-A'), false, 'another window of the same VS Code session');
  assert.equal(await claim(111, 'session-A'), false, 'the same window again (e.g. after “取消”)');
  alive.delete(111);
  assert.equal(await claim(222, 'session-B'), true, 'the first window is gone: the next startup offers it');
  const record = JSON.parse(await fs.readFile(session.largeMergePromptPath(paths), 'utf8'));
  assert.deepEqual({ sessionId: record.sessionId, processId: record.processId, hostBootId: record.hostBootId },
    { sessionId: 'session-B', processId: 222, hostBootId: 'window-222' });
  assert.equal(path.relative(root, session.largeMergePromptPath(paths)), path.join('.limcode-runtime-merges', 'prompts', 'large-merge-session.json'));
  // Two windows at once: the admission lets exactly one take it.
  alive.add(444);
  alive.add(555);
  alive.delete(222);
  const both = await Promise.all([claim(444, 'session-C'), claim(555, 'session-D')]);
  assert.deepEqual(both.sort(), [false, true]);
});

test('进度节流：本窗口的进度通知每 0.5 秒最多一次、总以最新的一条结束；其它窗口看到的阶段按 5% 一档', () => {
  assert.equal(session.LARGE_MERGE_SESSION.progressIntervalMs, 500);
  assert.equal(session.LARGE_MERGE_SESSION.stageStepPercent, 5);
  assert.equal(session.LARGE_MERGE_SESSION.countdownSeconds, 60);
  let now = 0;
  const timers = [];
  const clock = {
    now: () => now,
    setTimeout: (callback, ms) => { const timer = { at: now + ms, callback }; timers.push(timer); return timer; },
    clearTimeout: (timer) => { timers.splice(timers.indexOf(timer), 1); }
  };
  const advance = (ms) => {
    now += ms;
    for (const timer of [...timers].sort((left, right) => left.at - right.at)) {
      if (timer.at <= now) { timers.splice(timers.indexOf(timer), 1); timer.callback(); }
    }
  };
  const shown = [];
  const throttle = session.createLargeMergeThrottle((value) => shown.push([now, value]), 500, clock);
  for (let i = 0; i < 100; i += 1) { throttle.push(i); advance(10); }
  advance(500);
  // The first at once, then the latest when each interval is up.
  assert.deepEqual(shown.map(([, value]) => value), [0, 49, 99]);
  assert.ok(shown.every(([at], index) => index === 0 || at - shown[index - 1][0] >= 500));
  throttle.push(100);
  throttle.push(101);
  throttle.stop();
  advance(1_000);
  assert.deepEqual(shown.slice(3).map(([, value]) => value), [100], 'shown at once after a quiet interval; a waiting one is dropped by stop');

  const stage = (rowsDone, index = 0) => session.largeMergeStage({ index, total: 4, candidateId: 'x', rowsDone, rowsTotal: 380_000 });
  assert.equal(stage(0), '第 1/4 份，已完成 0%');
  assert.equal(stage(18_999), '第 1/4 份，已完成 0%');
  assert.equal(stage(19_000), '第 1/4 份，已完成 5%');
  assert.equal(stage(133_000, 1), '第 2/4 份，已完成 35%');
  assert.equal(stage(380_000, 3), '第 4/4 份，已完成 100%');
  const distinct = new Set(Array.from({ length: 1_000 }, (_, i) => stage(i * 380, Math.floor(i / 250))));
  assert.ok(distinct.size <= 21 + 4, `${distinct.size} stages`);
});

test('文案：进度“正在合并较大的旧聊天记录 2/4（已处理 12 万 / 38 万条，约还需 3 分钟）”（引擎报的是已比较的来源行数，不只是写入的）、等待中只写规模不编时长、倒计时写明后台准备与所有窗口暂停两段时长、剩余时间与区间', () => {
  const progress = { index: 1, total: 4, candidateId: 'x', rowsDone: 120_000, rowsTotal: 380_000 };
  assert.equal(session.largeMergeProgressMessage(progress, 2.5 * MINUTE), '正在合并较大的旧聊天记录 2/4（已处理 12 万 / 38 万条，约还需 3 分钟）');
  assert.equal(session.largeMergeProgressMessage({ ...progress, rowsDone: 3_000, rowsTotal: 8_000 }, 20_000),
    '正在合并较大的旧聊天记录 2/4（已处理 3000 / 8000 条，约还需不到 1 分钟）');
  assert.equal(session.largeMergeWaitingText(750_000), '约 75 万条记录，开始前给出预计时长');
  assert.equal(session.formatLargeMergeRows(15_500), '1.6 万');
  assert.equal(session.formatLargeMergeRows(1_234_567), '123 万');
  // Early on the preparation's estimate, later the rate so far.
  assert.equal(session.estimateLargeMergeRemainingMs({ elapsedMs: 5_000, rowsDone: 100, rowsTotal: 380_000, expectedMs: 4 * MINUTE }), 4 * MINUTE - 5_000);
  assert.equal(session.estimateLargeMergeRemainingMs({ elapsedMs: MINUTE, rowsDone: 190_000, rowsTotal: 380_000, expectedMs: 10 * MINUTE }), MINUTE);
  const duration = { expectedMs: 3.75 * MINUTE, minMs: 3 * MINUTE, maxMs: 6 * MINUTE };
  assert.equal(session.formatLargeMergeRange(duration), '3–6 分钟');
  assert.equal(session.formatLargeMergeRange({ expectedMs: 30_000, minMs: 24_000, maxMs: 48_000 }), '约 1 分钟');
  // “约 …” for the two parts the prompt and the confirmation name; never “约 约”, and “不到 1 分钟” when even the longest is shorter.
  assert.equal(session.formatLargeMergeAbout(duration), '约 3–6 分钟');
  assert.equal(session.formatLargeMergeAbout({ minMs: 120_000, maxMs: 120_000 }), '约 2 分钟');
  assert.equal(session.formatLargeMergeAbout({ minMs: 24_000, maxMs: 48_000 }), '不到 1 分钟');
  // The estimate's two parts: the background preparation after the countdown (windows usable), then the pause of every window.
  const preparing = { expectedMs: 40_000, minMs: 16_000, maxMs: 100_000 };
  assert.equal(session.largeMergeCountdownText({ seconds: 60, sources: 4, rows: 750_000, preparing, duration }),
    '将在 60 秒后合并 4 份较大的旧聊天记录（约 75 万条）。倒计时结束后先在后台准备约 1–2 分钟（期间照常可用），准备好后所有 LimCode 窗口重载一次，'
    + '暂停约 3–6 分钟（显示进度，完成后自动恢复，未发送的输入会保留）。点“取消”改到下次启动。');
  assert.equal(session.largeMergeCountdownText({ seconds: 1, sources: 1, rows: 8_000, preparing: { expectedMs: 5_000, minMs: 2_000, maxMs: 12_500 }, duration }),
    '将在 1 秒后合并 1 份较大的旧聊天记录（约 8000 条）。倒计时结束后先在后台准备不到 1 分钟（期间照常可用），准备好后所有 LimCode 窗口重载一次，'
    + '暂停约 3–6 分钟（显示进度，完成后自动恢复，未发送的输入会保留）。点“取消”改到下次启动。');
  assert.deepEqual(session.sumLargeMergeDurations([duration, duration]), { expectedMs: 7.5 * MINUTE, minMs: 6 * MINUTE, maxMs: 12 * MINUTE });
});

test('结果：按在线合并的批结果报告（点了取消的那一份总会说明）；详情逐份写新增的对话数或原因；重载后只在 10 分钟内重新打开才提示一次', async () => {
  const merged = { candidateId: 'workspace:a', state: 'merged', result: mergeResult('workspace:a', 12, { skippedConversations: 2 }) };
  const cancelled = { candidateId: 'workspace:b', state: 'cancelled', code: 'runtime-data-set-merge-large-session-cancelled', message: '合并时取消了，这一份已撤回。' };
  const failed = { candidateId: 'workspace:c', state: 'failed', code: 'runtime-data-set-merge-source-invalid', message: '来源格式不对。' };
  const report = session.largeMergeBatchResult([merged, cancelled, failed], false);
  assert.deepEqual(report.merged.map((item) => [item.candidateId, item.exclusive]), [['workspace:a', true]]);
  assert.deepEqual(report.deferred, [{ candidateId: 'workspace:b', code: cancelled.code, message: cancelled.message, newly: true, requested: true }]);
  assert.deepEqual(report.failures.map((item) => [item.candidateId, item.requested]), [['workspace:c', undefined]]);
  // A foreign history root: the reasons list after the session shows its readable name (a local source has none, its id is shown).
  const label = '外来历史库（拷来的数据目录 · backup-2026）';
  const foreignOutcomes = [{ ...failed, candidateId: 'foreign:copy:1', label }, { ...cancelled, candidateId: 'foreign:copy:2', label }];
  const foreignReport = session.largeMergeBatchResult(foreignOutcomes, false);
  assert.deepEqual([...foreignReport.failures, ...foreignReport.deferred].map((item) => [item.candidateId, item.label]),
    [['foreign:copy:1', label], ['foreign:copy:2', label]]);
  assert.ok(!('label' in report.failures[0]) && !('label' in report.deferred[0]), 'no name made up for a local source');
  // Named as the candidate list names them (project names it read, else the kind of history); the id only when unnamed.
  const sources = [
    { candidateId: 'workspace:a', label: 'limcode、notes', runtimeDataRootPath: '/a', rows: 300_000 },
    { candidateId: 'workspace:b', label: '旧工作区历史', runtimeDataRootPath: '/b', rows: 8_000 },
    { candidateId: 'default', label: '默认历史库', runtimeDataRootPath: '/c', rows: 100_000 },
    { candidateId: 'workspace:d', runtimeDataRootPath: '/d', rows: 100_000 }
  ];
  const failedDefault = { ...failed, candidateId: 'default' };
  assert.deepEqual(session.largeMergeDetails(sources, [merged, cancelled, failedDefault]), [
    'limcode、notes（/a，约 30 万条记录）：新增 12 个对话，另有 2 个在当前库删除过的对话没有再合并。',
    '旧工作区历史（/b，约 8000 条记录）：没有合并，合并时取消了，这一份已撤回。',
    '默认历史库（/c，约 10 万条记录）：没有合并，来源格式不对。',
    'workspace:d（/d，约 10 万条记录）：这次没有合并，以后启动时会再合并。'
  ]);
  // Nothing new (merged meanwhile), and a source whose location the engine did not say.
  const current = { candidateId: 'workspace:e', state: 'merged', result: mergeResult('workspace:e', 0, { alreadyMerged: true }) };
  assert.deepEqual(session.largeMergeDetails([{ candidateId: 'workspace:e', rows: 50_000 }], [current]), [
    'workspace:e（约 5 万条记录）：已合并到当前历史库，没有新内容。'
  ]);
  const state = memento();
  await session.keepLargeMergeResult(state, { configurationRootPath: '/root', requested: false, report, details: ['x'] }, 1_000);
  assert.equal(session.takeLargeMergeResult(state, 1_000 + 11 * MINUTE), undefined, 'reopened too late');
  assert.equal(session.takeLargeMergeResult(state, 1_000), undefined, 'read once');
  await session.keepLargeMergeResult(state, { configurationRootPath: '/root', requested: true, details: [], error: '出错了' }, 1_000);
  assert.deepEqual(plain(session.takeLargeMergeResult(state, 1_000 + 9 * MINUTE)), { configurationRootPath: '/root', requested: true, details: [], error: '出错了' });
});

test('适配层：等待列表来自本窗口最近一次批结果里等大库会话的来源（按 candidateId 记审计的规模，不编时长，按配置根分开）；引擎结果的映射：没有新内容算已合并、取消时正在合并的那一份是 cancelled、没开始的写明原因', async () => {
  const engine = engineModule.largeMergeEngine();
  const paths = { globalStoragePath: path.join(os.tmpdir(), 'limcode-large-merge-waiting-cache') };
  const batch = (overrides) => ({ merged: [], deferred: [], blocked: [], failures: [], pendingSources: 0, stopped: false, ...overrides });
  const awaiting = (candidateId, rows) => ({
    candidateId, code: 'runtime-data-set-merge-awaiting-exclusive', message: '等待', newly: true, size: { rows, bytes: rows * 100 }
  });
  assert.deepEqual(await engine.waiting(paths), []);
  engine.noteBatch(paths, batch({ deferred: [awaiting('workspace:a', 70_000), awaiting('workspace:b', 5_000), { candidateId: 'workspace:c', code: 'runtime-hosts-active', message: '忙' }] }));
  assert.deepEqual(await engine.waiting(paths), [
    { candidateId: 'workspace:a', rows: 70_000, bytes: 7_000_000 }, { candidateId: 'workspace:b', rows: 5_000, bytes: 500_000 }
  ]);
  assert.deepEqual(await engine.waiting({ globalStoragePath: path.join(os.tmpdir(), 'limcode-another-root') }), [], 'per configuration root');
  // A later batch (e.g. the user's click on one source) changes only what it judged.
  engine.noteBatch(paths, batch({ merged: [mergeResult('workspace:a', 3)] }));
  assert.deepEqual((await engine.waiting(paths)).map((item) => item.candidateId), ['workspace:b']);
  engine.noteBatch(paths, batch({ blocked: [{ candidateId: 'workspace:b', code: 'runtime-data-set-merge-conflict', message: '冲突' }] }));
  assert.deepEqual(await engine.waiting(paths), []);

  const map = engineModule.largeMergeSourceOutcome;
  const result = mergeResult('workspace:a', 0);
  assert.deepEqual(map({ candidateId: 'workspace:a', state: 'merged', result }), { candidateId: 'workspace:a', state: 'merged', result });
  assert.deepEqual(map({ candidateId: 'workspace:a', state: 'current', result }),
    { candidateId: 'workspace:a', state: 'merged', result: { ...result, alreadyMerged: true } }, 'nothing new: merged, told as such');
  assert.deepEqual(map({ candidateId: 'workspace:a', state: 'deferred', issue: { candidateId: 'workspace:a', code: 'runtime-data-set-merge-cancelled', message: '合并已取消' } }),
    { candidateId: 'workspace:a', state: 'cancelled', code: 'runtime-data-set-merge-cancelled', message: '合并时取消了，这一份已撤回，以后启动时会再合并。' });
  assert.deepEqual(map({ candidateId: 'workspace:b', state: 'not-run', reason: 'cancelled' }),
    { candidateId: 'workspace:b', state: 'deferred', code: 'runtime-data-set-merge-cancelled', message: '合并中途取消了，这一份还没有开始，以后启动时会再合并。' });
  assert.deepEqual(map({ candidateId: 'workspace:b', state: 'not-run', reason: 'disk-full' }),
    { candidateId: 'workspace:b', state: 'deferred', code: 'runtime-data-set-merge-disk-full', message: '前一份合并时磁盘空间不足，这一份没有开始；腾出空间后会再合并。' });
  for (const state of ['deferred', 'blocked', 'failed']) {
    assert.deepEqual(map({ candidateId: 'workspace:c', state, issue: { candidateId: 'workspace:c', code: `code-${state}`, message: `为什么 ${state}` } }),
      { candidateId: 'workspace:c', state, code: `code-${state}`, message: `为什么 ${state}` });
  }
  // A foreign history root keeps its readable name (its issue's, else the one the preparation gave it
  // when it never started): the reasons after the session name it by that, not by its id.
  const label = '外来历史库（归档 · 20260901-010203-004-abcdef12）';
  const id = 'foreign:archive:0123456789abcdef';
  for (const state of ['deferred', 'blocked', 'failed']) {
    assert.deepEqual(map({ candidateId: id, state, issue: { candidateId: id, code: `code-${state}`, message: `为什么 ${state}`, label } }),
      { candidateId: id, state, code: `code-${state}`, message: `为什么 ${state}`, label });
  }
  assert.deepEqual(map({ candidateId: id, state: 'deferred', issue: { candidateId: id, code: 'runtime-data-set-merge-cancelled', message: '合并已取消', label } }),
    { candidateId: id, state: 'cancelled', code: 'runtime-data-set-merge-cancelled', message: '合并时取消了，这一份已撤回，以后启动时会再合并。', label });
  assert.deepEqual(map({ candidateId: id, state: 'not-run', reason: 'cancelled' }, label),
    { candidateId: id, state: 'deferred', code: 'runtime-data-set-merge-cancelled', message: '合并中途取消了，这一份还没有开始，以后启动时会再合并。', label });
  assert.deepEqual(map({ candidateId: id, state: 'not-run', reason: 'disk-full' }, label),
    { candidateId: id, state: 'deferred', code: 'runtime-data-set-merge-disk-full', message: '前一份合并时磁盘空间不足，这一份没有开始；腾出空间后会再合并。', label });
  assert.equal(map({ candidateId: id, state: 'blocked', issue: { candidateId: id, code: 'c', message: 'm', label } }, '别的名称').label, label, 'the issue says it first');
});

test('适配层接真实引擎：先只读估计（不在配置准入内；什么都不准备、不备份、不写账本，复制核验一次后按缓存估计；指纹与准备同义、准备与暂停两段时长、空间含目标备份），threshold 为 online，中等来源一起准备、更小的写明留给在线合并；进度按阶段写成文字；来源带标签（候选列表读过的项目名，否则写库的种类）、指纹、行数、预计区间，空间照搬引擎的数字；release 交还声明；run 的进度是整个会话的已处理行数与引擎的剩余时间，结果映射为已合并', async (t) => {
  const fixture = await mergeFixture.createConfigurationRoot({ beta: true });
  t.after(() => fs.rm(fixture.root, { recursive: true, force: true }));
  const small = await mergeFixture.initializeScope(fixture.paths, 'small');
  await mergeFixture.generateSyntheticSource(fixture.alpha, { rows: 5_000, prefix: 'alpha' });
  await mergeFixture.generateSyntheticSource(fixture.beta, { rows: 4_500, prefix: 'beta' });
  await mergeFixture.generateSyntheticSource(small, { rows: 100, prefix: 'small' });
  // The candidate list read alpha's summary in this process (its project names label it); beta's it did not read.
  await mergeFixture.seedConversations(fixture.alpha, [{ id: 'alpha_named', project: { uri: 'file:///workspace/alpha-project', name: 'alpha-project' } }]);
  const alphaCandidate = (await inspectVscodeRuntimeDataSets(fixture.paths)).candidates.find((candidate) => candidate.id === fixture.alpha.id);
  assert.deepEqual((await summarizeRuntimeDataSet(alphaCandidate)).projectNames, ['alpha-project']);
  const engine = engineModule.largeMergeEngine();
  const ids = [fixture.alpha.id, fixture.beta.id, small.id];
  const openDatabase = () => kernel.RuntimeDatabase.open(fixture.current.authority, { hostBootId: `adapter-${Date.now()}` });
  const estimateOnce = async () => {
    const database = await openDatabase();
    const messages = [];
    try {
      const estimated = await engine.estimate({
        paths: fixture.paths, target: { configurationRootPath: fixture.root, database }, candidateIds: ids, requested: false,
        onProgress: (message) => messages.push(message)
      });
      return { estimated, messages };
    } finally { await database.close(); }
  };
  // Never inside the configuration admission (a foreign root's claim comes before it).
  const inside = await openDatabase();
  try {
    await assert.rejects(withRuntimeDataRootAdmission(fixture.root, () => engine.estimate({
      paths: fixture.paths, target: { configurationRootPath: fixture.root, database: inside }, candidateIds: ids, requested: false
    })), /outside the configuration admission/);
  } finally { await inside.close(); }
  const sourceTrees = async () => Promise.all([fixture.alpha, fixture.beta, small].map((dataSet) => mergeFixture.treeSnapshot(path.dirname(dataSet.binding.paths.dataRootPath))));
  const targetControl = path.dirname(fixture.current.binding.paths.dataRootPath);
  const treesBefore = await sourceTrees();
  const targetBefore = await fs.readdir(targetControl);
  const estimate = await estimateOnce();
  const { estimated } = estimate;
  assert.deepEqual(estimated.sources.map((source) => source.candidateId).sort(), [fixture.alpha.id, fixture.beta.id].sort());
  for (const source of estimated.sources) {
    assert.equal(source.label, source.candidateId === fixture.alpha.id ? 'alpha-project' : '旧工作区历史');
    assert.match(source.fingerprint, /^[0-9a-f]{16,}$/);
    assert.ok(source.rows > 4_000 && source.databaseBytes > 0, JSON.stringify(source));
    assert.equal(source.cached, false, 'never audited before: copied and audited once');
    for (const part of [source.preparing, source.duration]) assert.ok(part.minMs <= part.expectedMs && part.expectedMs <= part.maxMs, JSON.stringify(part));
  }
  // The engine's totals: the preparation with its one target backup, the pause of every window.
  assert.ok(estimated.preparing.expectedMs >= estimated.sources.reduce((sum, source) => sum + source.preparing.expectedMs, 0));
  assert.equal(estimated.duration.expectedMs, estimated.sources.reduce((sum, source) => sum + source.duration.expectedMs, 0));
  assert.ok(estimated.preparing.minMs <= estimated.preparing.expectedMs && estimated.preparing.expectedMs <= estimated.preparing.maxMs);
  assert.ok(estimated.duration.minMs <= estimated.duration.expectedMs && estimated.duration.expectedMs <= estimated.duration.maxMs);
  assert.equal(estimated.stopped, false);
  assert.deepEqual(estimated.report.deferred.map((issue) => [issue.candidateId, issue.code]), [[small.id, 'runtime-data-set-merge-large-session-small']]);
  assert.ok(estimate.messages.length > 0 && estimate.messages.every((message) => /^第 [123]\/3 份：正在(复制一份只读副本|核验只读副本)$/.test(message)), estimate.messages.join('\n'));
  // Read-only: nothing finalized, backed up or recorded, no preparation claim; only the audit cache written.
  assert.deepEqual(await sourceTrees(), treesBefore, '来源一字节不变');
  assert.deepEqual(await fs.readdir(targetControl), targetBefore, '当前库没有备份');
  for (const section of ['preparing', 'records', 'commits']) assert.deepEqual(await mergeFixture.ledgerEntries(fixture, section), [], section);
  assert.ok((await mergeFixture.ledgerEntries(fixture, 'audits')).length >= 2, 'audits cached');
  // Asked again: from the cache (nothing copied, no progress to show), the same fingerprints. And the engine's own
  // figures for the same files and target, passed on as they are: the preparation's times as `preparing`, the exclusive phase's as `duration`.
  const both = await openDatabase();
  const again = { messages: [] };
  let raw;
  try {
    again.estimated = await engine.estimate({
      paths: fixture.paths, target: { configurationRootPath: fixture.root, database: both }, candidateIds: ids, requested: false,
      onProgress: (message) => again.messages.push(message)
    });
    raw = await estimateLargeMergeSources({ paths: fixture.paths, target: { configurationRootPath: fixture.root, database: both }, candidateIds: ids, threshold: 'online' });
  } finally { await both.close(); }
  assert.deepEqual(again.messages, []);
  assert.ok(again.estimated.sources.every((source) => source.cached));
  assert.deepEqual(again.estimated.sources.map((source) => source.fingerprint), estimated.sources.map((source) => source.fingerprint));
  const range = (ms, [minMs, maxMs]) => ({ expectedMs: ms, minMs, maxMs });
  assert.deepEqual([again.estimated.preparing, again.estimated.duration],
    [range(raw.prepareEstimateMs, raw.prepareEstimateRangeMs), range(raw.sessionEstimateMs, raw.sessionEstimateRangeMs)]);
  assert.deepEqual(again.estimated.sources.map((source) => [source.candidateId, source.rows, source.databaseBytes, source.preparing, source.duration]),
    raw.sources.map((source) => [source.candidateId, source.rows, source.databaseBytes,
      range(source.prepareEstimateMs, source.prepareEstimateRangeMs), range(source.sessionEstimateMs, source.sessionEstimateRangeMs)]));
  assert.deepEqual(again.estimated.space, {
    targetDirectory: raw.space.targetDirectory, targetBytes: raw.space.targetBytes, temporaryDirectory: raw.space.temporaryDirectory, temporaryBytes: raw.space.temporaryBytes,
    sqliteTemporaryDirectory: raw.space.sqliteTemporaryDirectory, sqliteTemporaryBytes: raw.space.sqliteTemporaryBytes
  });
  const prepareOnce = async () => {
    const database = await kernel.RuntimeDatabase.open(fixture.current.authority, { hostBootId: `adapter-${Date.now()}` });
    const messages = [];
    try {
      const preparation = await engine.prepare({
        paths: fixture.paths, target: { configurationRootPath: fixture.root, database }, candidateIds: ids, requested: false,
        onProgress: (message) => messages.push(message)
      });
      return { preparation, messages };
    } finally { await database.close(); }
  };
  const first = await prepareOnce();
  const { preparation } = first;
  // Above the online bound: prepared (with the in-memory threshold they would all be left to the online batch).
  assert.deepEqual(preparation.sources.map((source) => source.candidateId).sort(), [fixture.alpha.id, fixture.beta.id].sort());
  // The estimate's fingerprints are the preparation's (no unfinished work was closed): the key asked before the countdown is the session's.
  assert.equal(session.largeMergeOperationKey(fixture.current.binding, estimated.sources), session.largeMergeOperationKey(fixture.current.binding, preparation.sources));
  // The estimate's space also has the online target backup the preparation took since.
  assert.ok(estimated.space.targetBytes > preparation.space.targetBytes, JSON.stringify([estimated.space, preparation.space]));
  for (const source of preparation.sources) {
    assert.equal(source.label, source.candidateId === fixture.alpha.id ? 'alpha-project' : '旧工作区历史');
    assert.match(source.fingerprint, /^[0-9a-f]{16,}$/);
    assert.ok(source.rows > 4_000 && source.databaseBytes > 0, JSON.stringify(source));
    assert.ok(source.duration.minMs <= source.duration.expectedMs && source.duration.expectedMs <= source.duration.maxMs, JSON.stringify(source.duration));
    assert.ok(source.runtimeDataRootPath.startsWith(fixture.root));
  }
  // The small one is told as such (the next online batch merges it).
  assert.deepEqual(preparation.report.deferred.map((issue) => [issue.candidateId, issue.code, issue.message]),
    [[small.id, 'runtime-data-set-merge-large-session-small', '这份旧聊天记录不需要所有窗口暂停，下次启动时会在后台直接合并。']]);
  assert.ok(preparation.space.targetBytes > 0 && preparation.space.temporaryBytes > 0 && preparation.space.targetDirectory && preparation.space.temporaryDirectory);
  assert.ok(preparation.space.sqliteTemporaryBytes > 0 && preparation.space.sqliteTemporaryDirectory, JSON.stringify(preparation.space));
  assert.ok(first.messages.some((message) => /^第 [123]\/3 份：正在复制一份只读副本$/.test(message)), first.messages.join('\n'));
  assert.ok(first.messages.some((message) => /^第 [123]\/3 份：正在备份当前历史库$/.test(message)), first.messages.join('\n'));
  assert.ok(first.messages.every((message) => /^第 [123]\/3 份：正在(复制一份只读副本|逐条比较|收尾中断的任务|复制正文|备份当前历史库)/.test(message)), first.messages.join('\n'));
  // Released: the preparing records go (another window may prepare them now).
  assert.ok((await mergeFixture.ledgerEntries(fixture, 'preparing')).length > 0);
  await engine.release(preparation);
  assert.deepEqual(await mergeFixture.ledgerEntries(fixture, 'preparing'), []);
  await engine.release(preparation);

  // Prepared again and run as the exclusive phase does: this process's Runtime closed, both claims held.
  const second = (await prepareOnce()).preparation;
  const progress = [];
  const outcomes = await withRuntimeDataRootAdmission(fixture.root, () => withRuntimeMaintenance(fixture.current.binding.paths, () => engine.run({
    paths: fixture.paths, target: { configurationRootPath: fixture.root, binding: fixture.current.binding }, preparation: second,
    onProgress: (value) => progress.push({ ...value })
  })));
  const rowsTotal = second.sources.reduce((sum, source) => sum + source.rows, 0);
  assert.deepEqual(outcomes.map((outcome) => [outcome.candidateId, outcome.state]), second.sources.map((source) => [source.candidateId, 'merged']));
  assert.deepEqual(outcomes.map((outcome) => outcome.result.insertedConversations).sort(), [72, 81]);
  assert.ok(progress.length > 0 && progress.every((value) => value.rowsTotal === rowsTotal && value.total === 2), JSON.stringify(progress.slice(0, 3)));
  for (let index = 1; index < progress.length; index += 1) assert.ok(progress[index].rowsDone >= progress[index - 1].rowsDone, '整个会话的已处理行数只增不减');
  assert.ok(progress.some((value) => value.index === 1 && value.rowsDone > second.sources[0].rows), '第二份接着第一份计数');
  assert.ok(progress.every((value) => ['checking', 'copying', 'merging', 'committing', 'checkpointing', 'recording'].includes(value.stage)));
  assert.ok(progress.some((value) => typeof value.remainingMs === 'number'), '引擎给出剩余时间');
  await engine.release(second);
  assert.deepEqual(await mergeFixture.ledgerEntries(fixture, 'preparing'), []);
});

// ---------------------------------------------------------------------------------------------
// The VS Code layer: real coordination (layer and primitive) and claims, fake engine.
// ---------------------------------------------------------------------------------------------

test('倒计时里点“取消”：只推迟到下次启动——倒计时之前只做了只读估计，什么都没准备（不收尾、不备份、不占声明，也没有要交还的）、不协调、不写账本、没有“永不”；倒计时写明后台准备与所有窗口暂停两段时长；同一会话里不再提示', async (t) => {
  const fixture = await createRoot(t);
  const window = loadWindow(fixture, { cancelCountdownAfterReports: 1 });
  await window.offer();
  // Only the read-only estimate (in the status bar), for exactly the sources the batch left to the session.
  assert.deepEqual(window.engine.calls, [['estimate', ['workspace:big-1', 'workspace:big-2'], false]]);
  const estimating = window.ui.progress.find((entry) => entry.title === '正在估计合并较大的旧聊天记录需要多久');
  assert.deepEqual([estimating?.location, estimating?.cancellable, estimating?.messages], [10, false, ['第 1/2 份：正在复制一份只读副本']]);
  assert.deepEqual(window.coordinations, [], 'never asked other windows');
  const countdown = window.ui.progress.find((entry) => entry.cancellable && entry.messages[0]?.startsWith('将在 '));
  assert.ok(countdown, JSON.stringify(window.ui.progress));
  assert.equal(countdown.title, undefined);
  // The estimate's totals: preparing two sources and the one target backup (1–5 minutes), then the pause (1–4 minutes).
  assert.equal(countdown.messages[0], '将在 2 秒后合并 2 份较大的旧聊天记录（约 40 万条）。倒计时结束后先在后台准备约 1–5 分钟（期间照常可用），'
    + '准备好后所有 LimCode 窗口重载一次，暂停约 1–4 分钟（显示进度，完成后自动恢复，未发送的输入会保留）。点“取消”改到下次启动。');
  assert.deepEqual(window.ui.infos, ['已改到下次启动时再合并较大的旧聊天记录；也可以在“历史与存储管理”里手动开始。']);
  assert.ok(!window.ui.infos.concat(window.ui.warnings.map((item) => item[0])).some((text) => /永不|不再提示/.test(text)));
  // Nothing recorded: only the prompt record exists beside the ledger.
  assert.deepEqual(await fs.readdir(path.join(fixture.root, '.limcode-runtime-merges')), ['prompts']);
  assert.deepEqual(window.host.events, [], 'this window was never frozen or closed');
  // The same VS Code session: no second prompt (and no second estimate).
  await window.offer();
  assert.deepEqual(window.engine.calls.map((call) => call[0]), ['estimate']);
});

test('空间不够时不提示开始，只说明还差多少（同一原因只提示一次；按估计给出的数字，其中含准备要做的目标备份，什么都不准备）；手动开始同样在确认之前就不开始并说明', async (t) => {
  const fixture = await createRoot(t);
  const causes = new Set();
  const window = loadWindow(fixture, {
    freeBytes: 10 * 1024 * 1024,
    freshCause: async (code) => { const fresh = !causes.has(code); causes.add(code); return fresh; }
  });
  await window.offer();
  assert.equal(window.ui.progress.filter((entry) => entry.messages[0]?.startsWith('将在 ')).length, 0, 'no countdown');
  assert.deepEqual(window.engine.calls.map((call) => call[0]), ['estimate'], 'nothing prepared');
  assert.deepEqual(window.coordinations, []);
  assert.equal(window.ui.warnings.length, 1);
  assert.match(window.ui.warnings[0][0], /^有 2 份较大的旧聊天记录等待合并，但当前历史库所在的盘、临时目录、数据库临时文件目录（.+）剩余空间不足：需要约 .+，现在可用 10 MB，还差约 .+。腾出空间后，下次启动时会再提示；也可以在“历史与存储管理”里手动开始。$/);
  assert.deepEqual([...causes], ['runtime-data-set-merge-large-session-disk-full']);
  const again = loadWindow(fixture, { freeBytes: 10 * 1024 * 1024, sessionId: 'session-2', freshCause: async (code) => !causes.has(code) });
  await again.offer();
  assert.deepEqual(again.ui.warnings, [], 'told once per cause');
  const manual = loadWindow(fixture, { freeBytes: 10 * 1024 * 1024, confirm: '开始合并' });
  await manual.start();
  assert.deepEqual(manual.coordinations, []);
  assert.deepEqual(manual.engine.calls.map((call) => call[0]), ['estimate']);
  assert.equal(manual.ui.warnings.filter(([, options]) => options?.modal).length, 0, 'not asked to confirm');
  assert.equal(manual.ui.errors.length, 1);
  assert.equal(manual.ui.errors[0][0], '合并较大的旧聊天记录没有开始');
  assert.match(manual.ui.errors[0][1].detail, /还差约 .+。腾出空间后可以再试；已有数据未被修改。$/);
  // The estimate's figure decides (the preparation's backup and copied content in it), not what the session alone would need.
  const estimateSpace = {
    targetDirectory: fixture.paths.dataRootPath, targetBytes: 3 * 1024 ** 3, temporaryDirectory: path.dirname(fixture.root), temporaryBytes: 1024 * 1024,
    sqliteTemporaryDirectory: path.dirname(fixture.root), sqliteTemporaryBytes: 256 * 1024
  };
  const backupShort = loadWindow(fixture, { freeBytes: 1024 ** 3, estimateSpace, sessionId: 'session-3' });
  await backupShort.offer();
  assert.deepEqual(backupShort.engine.calls.map((call) => call[0]), ['estimate']);
  assert.equal(backupShort.ui.progress.filter((entry) => entry.messages[0]?.startsWith('将在 ')).length, 0, 'no countdown');
  assert.match(backupShort.ui.warnings.at(-1)?.[0] ?? '', /^有 2 份较大的旧聊天记录等待合并，但当前历史库所在的盘、临时目录、数据库临时文件目录（.+）剩余空间不足：需要约 3\.0 GB，现在可用 1\.0 GB，还差约 2\.0 GB。/);
});

test('独占开始前用 statfs 再核一次空间：协调期间空间被占掉时不关闭本窗口运行时、不合并、不重载，只说明还差多少（自动开始按原因只提示一次）', async (t) => {
  const fixture = await createRoot(t);
  // Plenty until this window froze for the exclusive phase (after go), then too little.
  const freeBytes = (host) => (host.events.some((event) => event[0] === 'freeze') ? 10 * 1024 * 1024 : 1e13);
  const manual = loadWindow(fixture, { confirm: '开始合并', freeBytes });
  await manual.start();
  assert.equal(manual.coordinations.length, 1, 'enough room before the coordination');
  assert.deepEqual(manual.engine.calls.map((call) => call[0]), ['estimate', 'prepare', 'release']);
  assert.deepEqual(manual.host.events.map((event) => event[0]), ['freeze', 'thaw'], 'this window\'s Runtime never closed');
  assert.deepEqual(manual.ui.commands, [], 'not reloaded');
  assert.match(manual.ui.warnings.at(-1)[0], /^较大的旧聊天记录这次没有合并：有 2 份较大的旧聊天记录等待合并，但当前历史库所在的盘、临时目录、数据库临时文件目录（.+）剩余空间不足：需要约 .+，现在可用 10 MB，还差约 .+。已有数据未被修改，可以稍后在“历史与存储管理”里再试。$/);
  assert.equal(session.takeLargeMergeResult(manual.state, Date.now()), undefined, 'nothing kept for a reload');
  const causes = new Set();
  const automatic = loadWindow(fixture, {
    sessionId: 'session-2', freeBytes, freshCause: async (code) => { const fresh = !causes.has(code); causes.add(code); return fresh; }
  });
  await automatic.offer();
  assert.deepEqual(automatic.host.events.map((event) => event[0]), ['freeze', 'thaw']);
  assert.deepEqual(automatic.ui.commands, []);
  assert.deepEqual([...causes], ['runtime-data-set-merge-large-session-disk-full']);
  assert.match(automatic.ui.infos.at(-1), /^较大的旧聊天记录这次没有合并：有 2 份.+还差约 .+。下次启动时会再提示；也可以在“历史与存储管理”里手动开始。$/);
});

test('手动开始：先只读估计（可取消的通知），再确认（写明份数、约多少条记录、后台准备与所有窗口暂停两段时长、会等任务结束、期间暂停与取消的含义），确认之后才准备；以明确调用协调（不越过冷却以外的退避、其它窗口只提示、锁外等忙窗口、协调中不可取消），冻结并关闭本窗口运行时后才合并，然后重载；结果留到重载之后', async (t) => {
  const fixture = await createRoot(t);
  // This window's earlier explicit operation of the same kind left its requester token (it may retry after its reload).
  const window = loadWindow(fixture, { confirm: '开始合并', requesterToken: 'kept-token' });
  const started = Date.now();
  await window.start();
  // Estimated read-only first (the user's click: requested), in a notification that can be cancelled.
  assert.deepEqual(window.engine.calls[0], ['estimate', ['workspace:big-1', 'workspace:big-2'], true]);
  const estimating = window.ui.progress.find((entry) => entry.title?.startsWith('正在估计'));
  assert.deepEqual([estimating.title, estimating.location, estimating.cancellable],
    ['正在估计合并较大的旧聊天记录需要多久（只读，窗口照常可用）', 15, true]);
  // Confirmed with the estimate before anything was prepared.
  const [title, options] = window.ui.warnings[0];
  assert.equal(title, '合并较大的旧聊天记录（2 份，约 40 万条记录）？');
  assert.equal(options.modal, true);
  assert.match(options.detail, /^先在后台准备约 1–5 分钟（窗口照常可用，可以取消），再等本窗口和其它 LimCode 窗口的任务结束（最多约 10 分钟），然后所有 LimCode 窗口重载一次，暂停约 1–4 分钟：其它窗口重载并显示进度/);
  assert.ok(!/分钟）？/.test(title));
  assert.deepEqual(window.order.slice(0, 4), ['estimate', 'confirm', 'hold:historical-merge', 'prepare'],
    '最后一轮盲审 #2：确认之后、准备之前就登记本窗口的会话（其它窗口的维护不会在准备中途让它重载）');
  assert.equal(window.order.at(-1), 'unhold', '会话结束才解除');
  // Nothing settled while both sources go on to the session: nothing to tell yet (not the batch's “这次没有合并” for a click).
  assert.deepEqual(window.reports, []);
  // Asked before the confirmation whether the cooldown would refuse it (the explicit call's view: no key backoff).
  assert.deepEqual(window.refusalQueries.map((query) => [query.operation, query.operationKey, query.ignoreBackoff, query.requesterHostBootId, query.requesterToken]),
    [['historical-merge', undefined, true, 'requester', 'kept-token']]);
  assert.match(options.detail, /合并时可以点“取消”：只撤回正在合并的那一份，已经合并完的保留，其余的以后启动时再合并。/);
  // The coordination: the user's explicit call.
  assert.equal(window.coordinations.length, 1);
  const coordination = window.coordinations[0];
  assert.deepEqual({
    operation: coordination.operation, ignoreBackoff: coordination.ignoreBackoff, confirmation: coordination.participantConfirmation,
    whenBusy: coordination.whenBusy, cancellable: coordination.cancellable, message: coordination.message,
    configurationRootPath: coordination.configurationRootPath, requesterHostBootId: coordination.requesterHostBootId
  }, {
    operation: 'historical-merge', ignoreBackoff: true, confirmation: 'notice', whenBusy: 'wait', cancellable: false,
    message: '为合并较大的旧聊天记录', configurationRootPath: fixture.root, requesterHostBootId: 'requester'
  });
  assert.equal(coordination.operationKey, session.largeMergeOperationKey(fixture.binding, window.sources));
  // Prepared by then: the waiting notification says how long the merge itself is expected to take.
  assert.equal(coordination.waitingTitle, '正在等待 LimCode 窗口空闲后合并较大的旧聊天记录（预计 1–4 分钟）');
  // Frozen before go, Runtime closed before the merge, reloaded after.
  assert.deepEqual(window.host.events.map((event) => event[0]), ['freeze', 'close', 'run', 'thaw']);
  assert.deepEqual(window.engine.calls.map((call) => call[0]), ['estimate', 'prepare', 'run', 'release'], 'released after the run (nothing left then)');
  assert.deepEqual(window.engine.calls[1], ['prepare', ['workspace:big-1', 'workspace:big-2']]);
  assert.deepEqual(window.host.events[0], ['freeze', '合并较大的旧聊天记录']);
  assert.ok(window.order.indexOf('close') < window.order.indexOf('run'));
  assert.deepEqual(window.ui.commands, ['workbench.action.reloadWindow']);
  // Windows waiting to open: the stages and the expected end (the upper end of the estimate).
  assert.deepEqual(window.stages.slice(0, 2), ['正在关闭发起合并的窗口的运行时', '第 1/2 份，已完成 0%']);
  assert.equal(window.ends.length, 1);
  // Two sources expected to take 60 s each, told as up to 1.6 times that: 192 s from the start of the merge.
  const expectedEnd = Date.parse(window.ends[0]);
  assert.ok(expectedEnd >= started + 192_000 && expectedEnd <= Date.now() + 192_000, window.ends[0]);
  // Kept for the reload: each source's conversations.
  const kept = plain(session.takeLargeMergeResult(window.state, Date.now()));
  assert.equal(kept.requested, true);
  assert.deepEqual(kept.report.merged.map((item) => [item.candidateId, item.insertedConversations]), [['workspace:big-1', 10], ['workspace:big-2', 11]]);
  assert.equal(kept.details[0], '旧工作区历史（/fixture/workspace:big-1，约 30 万条记录）：新增 10 个对话。');
});

test('首次启动自动开始：只读估计、倒计时，倒计时结束（没有推迟）才准备（可取消的通知，只准备估计剩下的来源）；然后按自动调用协调（不越过退避、其它窗口是不能否决的倒计时、锁外最多等 10 分钟）；等本窗口任务时提示一次', async (t) => {
  const fixture = await createRoot(t);
  // A kept token of an explicit call never helps an automatic one.
  const window = loadWindow(fixture, { busyForMs: 300, requesterToken: 'kept-token' });
  await window.offer();
  assert.deepEqual(window.order.slice(0, 4), ['estimate', 'countdown', 'hold:historical-merge', 'prepare'], 'prepared only after the countdown ran out');
  assert.equal(window.order.at(-1), 'unhold');
  assert.deepEqual(window.engine.calls.slice(0, 2), [['estimate', ['workspace:big-1', 'workspace:big-2'], false], ['prepare', ['workspace:big-1', 'workspace:big-2']]]);
  const preparing = window.ui.progress.find((entry) => entry.title?.startsWith('正在准备'));
  assert.deepEqual([preparing.title, preparing.location, preparing.cancellable], ['正在准备合并较大的旧聊天记录（窗口照常可用）', 15, true]);
  assert.equal(window.coordinations.length, 1);
  const coordination = window.coordinations[0];
  assert.deepEqual([coordination.ignoreBackoff, coordination.participantConfirmation, coordination.whenBusy, coordination.cancellable],
    [false, 'final-countdown', 'wait', false]);
  // Asked twice whether it would be refused before asking anyone: the cooldown before estimating, then before the
  // countdown with the key the estimate's fingerprints make (the one the coordination uses).
  const key = session.largeMergeOperationKey(fixture.binding, window.sources);
  assert.equal(coordination.operationKey, key);
  assert.deepEqual(window.refusalQueries.map((query) => [query.operationKey, query.ignoreBackoff, query.requesterToken]),
    [[undefined, false, undefined], [key, false, undefined]]);
  assert.equal(window.ui.infos.filter((text) => /本窗口有任务正在进行，合并较大的旧聊天记录会等它结束后再进行（最多等 10 分钟）/.test(text)).length, 1);
  assert.deepEqual(window.ui.commands, ['workbench.action.reloadWindow']);
  assert.equal(plain(session.takeLargeMergeResult(window.state, Date.now())).requested, false);
});

test('冻结期间新命令被拒：本窗口因迁移数据目录冻结时手动入口直接拒绝；确认之后才冻结的同样拒绝；会话自己冻结期间别的写命令被拒绝', async (t) => {
  const fixture = await createRoot(t);
  const window = loadWindow(fixture, { confirm: '开始合并' });
  const thaw = window.host.writeGate.freeze('迁移数据目录', []);
  await window.start();
  assert.deepEqual(window.ui.warnings.map((item) => item[0]), ['正在迁移数据目录，完成后再操作。没有开始合并较大的旧聊天记录。']);
  assert.deepEqual(window.engine.calls, []);
  thaw();
  // Frozen while the user was confirming: prepared, but refused before anything was coordinated.
  const later = loadWindow(fixture, { confirm: () => { later.host.writeGate.freeze('迁移数据目录', []); return '开始合并'; } });
  await later.start();
  assert.deepEqual(later.engine.calls.map((call) => call[0]), ['estimate', 'prepare', 'release']);
  assert.deepEqual(later.coordinations, []);
  assert.equal(later.ui.warnings.at(-1)[0], '正在迁移数据目录，完成后再操作。没有开始合并较大的旧聊天记录。');
  // The session's own freeze: other writes are refused with its reason while it runs (asserted
  // afterwards: the session reports an engine error instead of throwing it).
  let written;
  const running = loadWindow(fixture, {
    confirm: '开始合并', sessionId: 'session-3',
    onRun: async (host) => {
      written = await host.writeGate.run(async () => 'written').then((value) => value, (error) => error.message);
    }
  });
  await running.start();
  assert.equal(written, '正在合并较大的旧聊天记录，完成后再操作。');
  assert.equal(running.engine.calls.filter((call) => call[0] === 'run').length, 1);
  assert.equal(running.host.writeGate.frozen, false, 'thawed when the round ended');
});

test('独占执行中点“取消”：只撤回正在合并的那一份，已合并的保留，没开始的留到以后；本窗口照常重载，重载后说明每一份', async (t) => {
  const fixture = await createRoot(t);
  const window = loadWindow(fixture, {
    confirm: '开始合并',
    sources: [source('workspace:big-1', 300_000, 60_000), source('workspace:big-2', 100_000, 60_000), source('workspace:big-3', 50_000, 60_000)],
    cancelWhenMerging: 1
  });
  await window.start();
  const run = window.engine.calls.find((call) => call[0] === 'run');
  assert.equal(run[1].abortedBeforeCancel, false, 'not aborted before the user pressed “取消”');
  assert.equal(run[1].abortedAt, 1, 'aborted while the second source ran');
  assert.deepEqual(window.ui.commands, ['workbench.action.reloadWindow']);
  const kept = plain(session.takeLargeMergeResult(window.state, Date.now()));
  assert.deepEqual(kept.report.merged.map((item) => item.candidateId), ['workspace:big-1']);
  assert.deepEqual(kept.report.deferred.map((item) => [item.candidateId, item.code, item.requested]), [
    ['workspace:big-2', 'runtime-data-set-merge-large-session-cancelled', true],
    ['workspace:big-3', 'runtime-data-set-merge-large-session-not-started', true]
  ]);
  assert.match(kept.details[1], /^旧工作区历史（\/fixture\/workspace:big-2，.+）：没有合并，合并时取消了，这一份已撤回/);
});

test('进度节流（会话里）：进度通知每 0.5 秒最多更新一次，其它窗口的阶段只在换来源或每增加 5% 时变化', async (t) => {
  const fixture = await createRoot(t);
  const window = loadWindow(fixture, { confirm: '开始合并', progressEvents: 400, progressEveryMs: 3 });
  await window.start();
  const notification = window.ui.progress.find((entry) => entry.messages.some((message) => /^正在合并较大的旧聊天记录 /.test(message)));
  assert.ok(notification.cancellable, 'the exclusive phase can be cancelled');
  const reports = notification.reports;
  assert.ok(reports.length >= 2, JSON.stringify(reports));
  for (let i = 1; i < reports.length; i += 1) assert.ok(reports[i].at - reports[i - 1].at >= 450, JSON.stringify(reports));
  const stages = window.stages.filter((stage) => stage.startsWith('第 '));
  assert.equal(new Set(stages).size, stages.length, 'a stage is reported only when it changes');
  assert.ok(stages.length <= 21 + 2, stages.join(' | '));
  assert.ok(stages.every((stage) => /已完成 \d*[05]%$/.test(stage)));
});

test('一个窗口同一时间只有一个会话：启动提示倒计时期间手动开始只说明正在进行，不会再估计、确认、准备或协调一次', async (t) => {
  const fixture = await createRoot(t);
  const window = loadWindow(fixture, { cancelCountdownAfterReports: 2, confirm: '开始合并' });
  const offering = window.offer();
  await new Promise((resolve) => setTimeout(resolve, 50));
  await window.start();
  await offering;
  assert.ok(window.ui.infos.includes('本窗口已经在准备或进行合并较大的旧聊天记录，请等它结束。'), JSON.stringify(window.ui.infos));
  assert.equal(window.ui.warnings.filter(([, options]) => options?.modal).length, 0, 'no confirmation');
  // One estimate (the prompt's); never a second one while this window may hold a preparation of the same sources.
  assert.deepEqual(window.engine.calls.map((call) => call[0]), ['estimate']);
  assert.deepEqual(window.coordinations, []);
});

test('估计或准备时已经有结果的来源（已合并、没有新内容、被拒、推迟）按在线合并的批结果说明（估计的在倒计时或确认之前），用户点的那次每一条都会说明；只准备估计剩下的来源；没有合并的准备会被释放；什么都没剩也没结果时用户点的那次照样有回音；引擎给出的剩余时间优先', async (t) => {
  const fixture = await createRoot(t);
  const sources = [
    source('workspace:big-1', 300_000, 60_000), source('workspace:big-2', 100_000, 60_000),
    source('workspace:done', 70_000, 60_000), source('workspace:later', 70_000, 60_000), source('workspace:conflict', 70_000, 60_000)
  ];
  const estimateSettled = {
    merged: [mergeResult('workspace:done', 0, { alreadyMerged: true })],
    deferred: [{ candidateId: 'workspace:later', code: 'runtime-data-set-merge-preparing-elsewhere', message: '另一个窗口正在准备合并这份较大的旧聊天记录，由那个窗口完成。', newly: true }],
    blocked: [{ candidateId: 'workspace:conflict', code: 'runtime-data-set-merge-conflict', message: '数据冲突。', newly: false }],
    failures: []
  };
  // Settled by the estimate: told before the prompt; the prompt counts only the rest.
  const automatic = loadWindow(fixture, { sources, estimateSettled, cancelCountdownAfterReports: 1 });
  await automatic.offer();
  assert.equal(automatic.reports.length, 1);
  const [batch, requested] = automatic.reports[0];
  assert.equal(requested, false);
  assert.deepEqual(batch.merged.map((item) => [item.candidateId, item.alreadyMerged]), [['workspace:done', true]]);
  assert.deepEqual(batch.deferred.map((item) => [item.candidateId, item.requested, item.newly]), [['workspace:later', undefined, true]]);
  assert.deepEqual(batch.blocked.map((item) => [item.candidateId, item.requested, item.newly]), [['workspace:conflict', undefined, false]]);
  assert.deepEqual([batch.pendingSources, batch.stopped], [0, false]);
  assert.ok(automatic.order.indexOf('estimate') < automatic.order.indexOf('countdown'));
  assert.match(automatic.ui.progress.find((entry) => entry.messages[0]?.startsWith('将在 ')).messages[0], /^将在 2 秒后合并 2 份较大的旧聊天记录（约 40 万条）。/);
  assert.deepEqual(automatic.engine.calls.map((call) => call[0]), ['estimate'], 'postponed: nothing prepared');
  // The countdown ran out: only the sources the estimate left are prepared; what the preparation settled is told then.
  const prepareSettled = { merged: [mergeResult('workspace:big-2', 0, { alreadyMerged: true })], deferred: [], blocked: [], failures: [] };
  const going = loadWindow(fixture, { sources, estimateSettled, settled: prepareSettled, sessionId: 'session-2' });
  await going.offer();
  assert.deepEqual(going.engine.calls.find((call) => call[0] === 'prepare'), ['prepare', ['workspace:big-1', 'workspace:big-2']]);
  assert.deepEqual(going.reports.map(([report]) => report.merged.map((item) => item.candidateId)), [['workspace:done'], ['workspace:big-2']]);
  assert.equal(going.coordinations[0].operationKey, session.largeMergeOperationKey(fixture.binding, [sources[0]]), 'the session is the rest');
  const manual = loadWindow(fixture, {
    sources, estimateSettled, settled: prepareSettled, confirm: '开始合并', engineRemainingMs: 7 * 60_000 + 1, progressEvents: 150, progressEveryMs: 4
  });
  await manual.start();
  assert.equal(manual.reports.length, 2);
  const [clicked, clickedRequested] = manual.reports[0];
  assert.equal(clickedRequested, true);
  assert.deepEqual([...clicked.deferred, ...clicked.blocked].map((item) => item.requested), [true, true]);
  assert.ok(manual.order.indexOf('estimate') < manual.order.indexOf('confirm'));
  assert.equal(manual.ui.warnings.find(([, options]) => options?.modal)[0], '合并较大的旧聊天记录（2 份，约 40 万条记录）？');
  assert.deepEqual(manual.engine.calls.map((call) => call[0]), ['estimate', 'prepare', 'run', 'release']);
  const notification = manual.ui.progress.find((entry) => entry.messages.some((message) => /^正在合并较大的旧聊天记录 /.test(message)));
  // The first message comes before any progress (the preparation's estimate); every later one is the engine's.
  assert.ok(notification.messages.length >= 2, JSON.stringify(notification.messages));
  for (const message of notification.messages.slice(1)) assert.match(message, /约还需 8 分钟）$/);
  // Nothing left for the session and nothing settled (the sources went meanwhile): the click still hears back.
  const gone = loadWindow(fixture, { confirm: '开始合并', estimateSettled: { merged: [], deferred: [], blocked: [], failures: [] }, estimateNone: true });
  await gone.start();
  assert.deepEqual(gone.reports.map(([report, requestedHere]) => [report.merged.length + report.deferred.length + report.blocked.length + report.failures.length, requestedHere]), [[0, true]]);
  assert.deepEqual(gone.engine.calls.map((call) => call[0]), ['estimate']);
  assert.equal(gone.ui.warnings.filter(([, options]) => options?.modal).length, 0);
});

test('协调在询问任何窗口之前就会被挡住时（冷却、这项工作的退避或 blocked）：自动开始冷却中连估计都不做，按估计的指纹得出操作键后发现退避或 blocked 就不倒计时、什么都不准备，如实说明何时可以再试（按原因只提示一次）；手动开始在估计和确认之前就说明', async (t) => {
  const fixture = await createRoot(t);
  const reason = '刚刚已经为这项维护让其它窗口重载过一次，暂不再次要求其它窗口重载。约 10 分钟后（14:32 以后）可以再试。';
  const causes = new Set();
  const freshCause = async (code) => { const fresh = !causes.has(code); causes.add(code); return fresh; };
  // The cooldown: known before the work is (no key) — nothing is estimated, prepared or counted down.
  const cooling = loadWindow(fixture, { freshCause, refusal: () => ({ state: 'backoff', reason, retryAfter: new Date(Date.now() + 10 * MINUTE).toISOString() }) });
  await cooling.offer();
  assert.deepEqual(cooling.engine.calls, [], 'not estimated');
  assert.deepEqual(cooling.coordinations, []);
  assert.equal(cooling.ui.progress.filter((entry) => entry.messages[0]?.startsWith('将在 ')).length, 0, 'no countdown');
  assert.deepEqual(cooling.ui.infos, [`较大的旧聊天记录这次没有合并：${reason}下次启动时会再提示；也可以在“历史与存储管理”里手动开始。`]);
  assert.deepEqual([...causes], ['runtime-data-set-merge-large-session-backoff']);
  // This work's backoff: known once estimated (the key its fingerprints make) — no countdown, nothing prepared, and the same cause is not told again.
  const backingOff = loadWindow(fixture, {
    freshCause, sessionId: 'session-2', refusal: (input) => (input.operationKey ? { state: 'backoff', reason, retryAfter: new Date().toISOString() } : undefined)
  });
  await backingOff.offer();
  assert.deepEqual(backingOff.engine.calls.map((call) => call[0]), ['estimate'], 'nothing prepared, nothing to release');
  assert.equal(backingOff.refusalQueries.at(-1).operationKey, session.largeMergeOperationKey(fixture.binding, backingOff.sources));
  assert.equal(backingOff.ui.progress.filter((entry) => entry.messages[0]?.startsWith('将在 ')).length, 0, 'no countdown that would end in “没有合并”');
  assert.deepEqual(backingOff.coordinations, []);
  assert.deepEqual(backingOff.ui.infos, [], 'told once per cause');
  // The key blocked for automatic calls: the same.
  const blocked = loadWindow(fixture, {
    freshCause, sessionId: 'session-3', refusal: (input) => (input.operationKey ? { state: 'blocked', reason: '这项合并上次失败了，已停止自动重试。' } : undefined)
  });
  await blocked.offer();
  assert.deepEqual(blocked.engine.calls.map((call) => call[0]), ['estimate']);
  assert.equal(blocked.ui.progress.filter((entry) => entry.messages[0]?.startsWith('将在 ')).length, 0);
  assert.deepEqual(blocked.ui.infos, ['较大的旧聊天记录这次没有合并：这项合并上次失败了，已停止自动重试。下次启动时会再提示；也可以在“历史与存储管理”里手动开始。']);
  assert.deepEqual([...causes], ['runtime-data-set-merge-large-session-backoff', 'runtime-data-set-merge-large-session-blocked']);
  // The user's explicit start: said before anything is confirmed or prepared.
  const manual = loadWindow(fixture, { confirm: '开始合并', refusal: () => ({ state: 'backoff', reason, retryAfter: new Date().toISOString() }) });
  await manual.start();
  assert.deepEqual(manual.ui.warnings, [[`现在不能合并较大的旧聊天记录：${reason.replace(/。$/, '')}。已有数据未被修改。`, undefined]]);
  assert.deepEqual(manual.engine.calls, []);
  assert.deepEqual(manual.coordinations, []);
});

test('准备时点“取消”（或窗口关闭）：已经准备的部分交还引擎，不说明准备结果、不协调；自动开始的准备被取消同样只改到下次启动', async (t) => {
  const fixture = await createRoot(t);
  const window = loadWindow(fixture, { confirm: '开始合并', cancelPrepare: true });
  await window.start();
  assert.deepEqual(window.engine.calls.map((call) => call[0]), ['estimate', 'prepare', 'release']);
  assert.deepEqual(window.reports, []);
  assert.deepEqual(window.coordinations, []);
  assert.deepEqual(window.ui.commands, []);
  // After the countdown ran out: “取消” on the preparation's notification moves it to the next startup too.
  const automatic = loadWindow(fixture, { cancelPrepare: true });
  await automatic.offer();
  assert.deepEqual(automatic.engine.calls.map((call) => call[0]), ['estimate', 'prepare', 'release']);
  assert.deepEqual(automatic.coordinations, []);
  assert.deepEqual(automatic.ui.infos, ['已改到下次启动时再合并较大的旧聊天记录；也可以在“历史与存储管理”里手动开始。']);
  assert.deepEqual(automatic.host.events, []);
});

test('估计时点“取消”（或窗口关闭）、估计出错：什么都没准备、不确认、不协调；手动开始说明没有开始，自动开始按原因只提示一次', async (t) => {
  const fixture = await createRoot(t);
  const cancelled = loadWindow(fixture, { confirm: '开始合并', cancelEstimate: true });
  await cancelled.start();
  assert.deepEqual(cancelled.engine.calls.map((call) => call[0]), ['estimate']);
  assert.deepEqual([cancelled.reports, cancelled.coordinations, cancelled.ui.errors], [[], [], []]);
  assert.equal(cancelled.ui.warnings.filter(([, options]) => options?.modal).length, 0, 'not asked to confirm');
  const failing = loadWindow(fixture, { confirm: '开始合并', estimateError: '读不到来源' });
  await failing.start();
  assert.deepEqual(failing.engine.calls.map((call) => call[0]), ['estimate']);
  assert.deepEqual(failing.ui.errors.map(([message]) => message), ['合并较大的旧聊天记录没有开始：估计时出错（读不到来源）。已有数据未被修改。']);
  const causes = new Set();
  const freshCause = async (code) => { const fresh = !causes.has(code); causes.add(code); return fresh; };
  const automatic = loadWindow(fixture, { estimateError: '读不到来源', freshCause });
  await automatic.offer();
  assert.deepEqual(automatic.engine.calls.map((call) => call[0]), ['estimate']);
  assert.equal(automatic.ui.progress.filter((entry) => entry.messages[0]?.startsWith('将在 ')).length, 0);
  assert.deepEqual(automatic.ui.warnings.map(([message]) => message), ['合并较大的旧聊天记录暂时无法估计：读不到来源。已有数据未被修改，下次启动时会再试。']);
  const again = loadWindow(fixture, { estimateError: '读不到来源', freshCause, sessionId: 'session-2' });
  await again.offer();
  assert.deepEqual(again.ui.warnings, [], 'told once per cause');
  assert.deepEqual([...causes], ['runtime-data-set-merge-large-session-estimate']);
});

test('盲审 #5：准备整体出错时如实说明数据——没有收尾任何来源才说“已有数据未被修改”，已收尾的写明几份；磁盘满只说磁盘空间不足，不带系统原文', async (t) => {
  const fixture = await createRoot(t);
  const { LargeMergePreparationError } = engineModule;
  const full = new LargeMergePreparationError(Object.assign(new Error('ENOSPC: no space left on device, write'), { code: 'ENOSPC' }), 0);
  assert.equal(full.message, '磁盘空间不足');
  assert.equal(full.cause.code, 'ENOSPC');
  const untouched = loadWindow(fixture, { confirm: '开始合并', prepareError: full });
  await untouched.start();
  assert.deepEqual(untouched.ui.errors.map(([message]) => message), ['合并较大的旧聊天记录没有开始：准备时出错（磁盘空间不足）。已有数据未被修改。']);
  const finalized = loadWindow(fixture, { confirm: '开始合并', prepareError: new LargeMergePreparationError(new Error('读不到来源'), 1), sessionId: 'session-2' });
  await finalized.start();
  assert.deepEqual(finalized.ui.errors.map(([message]) => message), [
    '合并较大的旧聊天记录没有开始：准备时出错（读不到来源）。准备时已有 1 份旧聊天记录里中断的任务按“中止”收尾、排队未发送的消息被取消（都不会在当前库继续执行），其余数据未被修改。'
  ]);
  const automatic = loadWindow(fixture, { prepareError: new LargeMergePreparationError(new Error('读不到来源'), 2), sessionId: 'session-3' });
  await automatic.offer();
  assert.deepEqual(automatic.ui.warnings.map(([message]) => message).filter((message) => message.includes('无法准备')), [
    '合并较大的旧聊天记录暂时无法准备：读不到来源。准备时已有 2 份旧聊天记录里中断的任务按“中止”收尾、排队未发送的消息被取消（都不会在当前库继续执行），其余数据未被修改，下次启动时会再试。'
  ]);
});

test('会话开始时引擎自己的空间检查不够（或第一份就磁盘满）：什么都没合并，本窗口照常重载，重载后说一次“没有进行”和引擎给出的原因，不按每份各报一次', async (t) => {
  const fixture = await createRoot(t);
  const message = '磁盘空间不足，需要约 120 MB：合并较大的旧聊天记录要在 /fixture 暂存数据';
  const window = loadWindow(fixture, {
    confirm: '开始合并',
    runResult: (input) => input.preparation.sources.map((item) => ({ candidateId: item.candidateId, state: 'deferred', code: 'runtime-data-set-merge-disk-full', message }))
  });
  await window.start();
  assert.deepEqual(window.ui.commands, ['workbench.action.reloadWindow'], 'its Runtime was closed: reloaded');
  assert.deepEqual(plain(session.takeLargeMergeResult(window.state, Date.now())),
    { configurationRootPath: fixture.root, requested: true, details: [], notStarted: message });
});

// ---------------------------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------------------------

function mergeResult(candidateId, insertedConversations, extra = {}) {
  return {
    candidateId, sourceDataSetId: `${candidateId}-set`, targetDataSetId: 'target', insertedRows: 100, reusedRows: 0, insertedConversations,
    linkedCasObjects: 0, copiedCasObjects: 0, reusedCasObjects: 0, recoveredCommit: false, ...extra
  };
}

/** A source as the fake engine prepares it (its exclusive phase measured again), and as it estimates it (`preparing` added). */
function source(candidateId, rows, mergeMs, prepareMs = 30_000) {
  return {
    candidateId, label: '旧工作区历史', runtimeDataRootPath: `/fixture/${candidateId}`, fingerprint: `fp-${candidateId}`, rows, databaseBytes: 1024 * 1024,
    duration: { expectedMs: mergeMs, minMs: Math.round(mergeMs * 0.8), maxMs: Math.round(mergeMs * 1.6) },
    preparing: { expectedMs: prepareMs, minMs: Math.round(prepareMs * 0.4), maxMs: Math.round(prepareMs * 2.5) }
  };
}

/** The fake engine's online target backup, counted once in the estimate's total preparation (never in a source's). */
const TARGET_BACKUP = { expectedMs: 60_000, minMs: 24_000, maxMs: 150_000 };

/** The engine's figures (the session never computes its own): the sources, the largest one's WAL peak and 64 MiB, its SQLite temporary files; `extra` for the estimate's backup and copied content. */
function spaceFor(fixture, sources, extra = 0) {
  const largest = Math.max(0, ...sources.map((item) => item.databaseBytes));
  return {
    targetDirectory: fixture.paths.dataRootPath,
    targetBytes: sources.reduce((sum, item) => sum + item.databaseBytes, 0) + largest * 1.5 + 64 * 1024 * 1024 + extra,
    temporaryDirectory: path.dirname(fixture.root), temporaryBytes: largest,
    sqliteTemporaryDirectory: path.dirname(fixture.root), sqliteTemporaryBytes: Math.ceil(largest * 0.25)
  };
}

function memento() {
  const values = new Map();
  return { get: (key) => values.get(key), update: async (key, value) => { if (value === undefined) values.delete(key); else values.set(key, value); } };
}

/**
 * One window of this process with the real large merge layer (TypeScript source), the real
 * coordination layer and primitive on a real root, and a fake engine. No other window is open, so
 * the coordination goes straight to the locked round (beforeGo, the operation).
 */
function loadWindow(fixture, behavior = {}) {
  const ui = { progress: [], infos: [], warnings: [], errors: [], commands: [] };
  const order = [];
  const stages = [];
  const ends = [];
  const coordinations = [];
  const reports = [];
  const refusalQueries = [];
  const sources = behavior.sources ?? [source('workspace:big-1', 300_000, 60_000), source('workspace:big-2', 100_000, 60_000)];
  // Busy for busyForMs from the first time the coordination asks (after the countdown).
  let busyUntil;
  const vscode = {
    ProgressLocation: { Notification: 15, Window: 10 },
    env: { sessionId: behavior.sessionId ?? 'session-1' },
    window: {
      withProgress: async (options, task) => {
        const entry = { title: options.title, location: options.location, cancellable: options.cancellable === true, messages: [], reports: [] };
        ui.progress.push(entry);
        const listeners = [];
        const token = {
          isCancellationRequested: false,
          onCancellationRequested: (listener) => { listeners.push(listener); return { dispose() {} }; }
        };
        entry.cancel = () => { token.isCancellationRequested = true; for (const listener of listeners) listener(); };
        return task({
          report: (value) => {
            if (!value?.message) return;
            if (value.message.startsWith('将在 ') && !entry.messages.length) order.push('countdown');
            entry.messages.push(value.message);
            entry.reports.push({ at: Date.now(), message: value.message });
            if (behavior.cancelCountdownAfterReports && value.message.startsWith('将在 ') && entry.messages.length >= behavior.cancelCountdownAfterReports) entry.cancel();
          }
        }, token);
      },
      showInformationMessage: async (message) => { ui.infos.push(message); },
      showWarningMessage: async (message, options) => {
        ui.warnings.push([message, options]);
        if (!options?.modal) return undefined;
        order.push('confirm');
        return typeof behavior.confirm === 'function' ? behavior.confirm(message) : behavior.confirm;
      },
      showErrorMessage: async (message, options) => { ui.errors.push([message, options]); }
    },
    commands: { executeCommand: async (id) => { ui.commands.push(id); } }
  };
  // The read-only refusal query as the session asks it; the answer is the primitive's own unless the test gives one.
  const primitive = {
    ...exclusive,
    readExclusiveMaintenanceRefusal: async (paths, input) => {
      refusalQueries.push({ ...input });
      return behavior.refusal ? behavior.refusal(input) : exclusive.readExclusiveMaintenanceRefusal(paths, input);
    }
  };
  const layer = loadSource('vscode/runtimeExclusiveMaintenance.ts', {
    vscode, '../backend/reliableKernel/runtimeExclusiveMaintenance': primitive
  });
  const recordingLayer = {
    ...layer,
    // 最后一轮盲审 #2: this window holds its session from the user's agreement until it ended.
    holdOwnExclusiveMaintenanceWork: (holdHost, work) => {
      order.push(`hold:${work.operation}`);
      const release = layer.holdOwnExclusiveMaintenanceWork(holdHost, work);
      return () => { order.push('unhold'); release(); };
    },
    runWithExclusiveMaintenance: (paths, options, operation) => {
      coordinations.push(options);
      return layer.runWithExclusiveMaintenance(paths, { ...options, pollMs: 10 }, (context) => operation({
        reportStage: (stage) => { stages.push(stage); context.reportStage(stage); },
        reportExpectedEnd: (at) => { ends.push(at); context.reportExpectedEnd(at); }
      }));
    }
  };
  const lifetime = loadSource('vscode/runtimeDataSetUpgradeLifetime.ts', {});
  const module = loadSource('vscode/commands/largeHistoricalMerge.ts', {
    vscode,
    '../../backend/reliableKernel/runtimeExclusiveMaintenance': exclusive,
    '../../backend/reliableKernel/runtimeLargeMergeEngine': engineModule,
    '../../backend/reliableKernel/runtimeLargeMergeSession': session,
    '../../shared/extensionIdentity': extensionIdentity,
    '../panels/MainPanel': { MainPanel: { saveComposerDrafts: () => 0 } },
    '../runtimeDataSetUpgradeLifetime': lifetime,
    '../runtimeExclusiveMaintenance': recordingLayer
  });
  const writeGate = new RuntimeWriteGate();
  const host = {
    events: [],
    writeGate,
    product: { application: { database: { binding: fixture.binding, hostBootId: 'requester' } } },
    hasOwnedExecution: async () => {
      if (!behavior.busyForMs) return false;
      busyUntil ??= Date.now() + behavior.busyForMs;
      return Date.now() < busyUntil;
    },
    exclusiveMaintenanceTarget: () => ({ paths: fixture.paths, hostBootId: 'requester' }),
    dataRootPath: () => fixture.root,
    withDataRootLocks: (body) => withRuntimeDataRootAdmission(fixture.root, () => withRuntimeMaintenance(fixture.paths, body)),
    freezeNewWork: (activity) => {
      host.events.push(['freeze', activity]);
      const thawWrites = writeGate.freeze(activity, []);
      return () => { host.events.push(['thaw']); thawWrites(); };
    },
    closeRuntime: async () => { host.events.push(['close']); order.push('close'); }
  };
  const settledIds = (report) => [...(report?.merged ?? []), ...(report?.deferred ?? []), ...(report?.blocked ?? []), ...(report?.failures ?? [])]
    .map((item) => item.candidateId);
  const engine = {
    calls: [],
    waiting: async () => sources.map(({ candidateId, rows }) => ({ candidateId, rows, bytes: rows * 100 })),
    noteBatch: () => {},
    // Read-only: what the session would take (a source the estimate settled is left out), both durations, the space.
    estimate: async (input) => {
      order.push('estimate');
      engine.calls.push(['estimate', [...input.candidateIds], input.requested]);
      input.onProgress?.('第 1/2 份：正在复制一份只读副本');
      // The user pressed “取消” on the estimate's notification meanwhile (or the window closed).
      if (behavior.cancelEstimate) ui.progress.find((entry) => entry.title?.startsWith('正在估计'))?.cancel();
      if (behavior.estimateError) throw new Error(behavior.estimateError);
      const settled = settledIds(behavior.estimateSettled);
      const estimated = (behavior.estimateNone ? [] : sources)
        .filter((item) => input.candidateIds.includes(item.candidateId) && !settled.includes(item.candidateId))
        .map(({ duration, preparing, ...item }) => ({ ...item, preparing, duration, cached: true }));
      const sum = (durations) => session.sumLargeMergeDurations(durations);
      return {
        sources: estimated,
        report: behavior.estimateSettled ?? { merged: [], deferred: [], blocked: [], failures: [] },
        // The online target backup and the content copied into the target are in the estimate's figure.
        space: behavior.estimateSpace ?? spaceFor(fixture, estimated, estimated.length > 0 ? 2 * 1024 * 1024 : 0),
        preparing: estimated.length > 0 ? sum([...estimated.map((item) => item.preparing), TARGET_BACKUP]) : sum([]),
        duration: sum(estimated.map((item) => item.duration)),
        stopped: false
      };
    },
    prepare: async (input) => {
      order.push('prepare');
      engine.calls.push(['prepare', [...input.candidateIds]]);
      // The user pressed “取消” on the preparation's notification meanwhile.
      if (behavior.cancelPrepare) ui.progress.find((entry) => entry.title?.startsWith('正在准备'))?.cancel();
      if (behavior.prepareError) throw behavior.prepareError;
      const settled = settledIds(behavior.settled);
      const prepared = sources.filter((item) => input.candidateIds.includes(item.candidateId) && !settled.includes(item.candidateId))
        .map(({ preparing: _preparing, ...item }) => item);
      return {
        sources: prepared,
        report: behavior.settled ?? { merged: [], deferred: [], blocked: [], failures: [] },
        space: spaceFor(fixture, prepared),
        engineState: 'fake'
      };
    },
    release: async (preparation) => {
      engine.calls.push(['release', preparation.engineState]);
    },
    run: async (input) => {
      order.push('run');
      host.events.push(['run']);
      const call = { abortedBeforeCancel: input.signal.aborted, abortedAt: undefined };
      engine.calls.push(['run', call]);
      await behavior.onRun?.(host);
      if (behavior.runResult) return behavior.runResult(input);
      const rowsTotal = input.preparation.sources.reduce((sum, item) => sum + item.rows, 0);
      let rowsWritten = 0;
      const outcomes = [];
      for (const [index, item] of input.preparation.sources.entries()) {
        if (input.signal.aborted) {
          outcomes.push({ candidateId: item.candidateId, state: 'deferred', code: 'runtime-data-set-merge-large-session-not-started', message: '合并中途取消，这一份还没有开始。' });
          continue;
        }
        const events = behavior.progressEvents ?? 5;
        let cancelledHere = false;
        for (let step = 1; step <= events; step += 1) {
          await new Promise((resolve) => setTimeout(resolve, behavior.progressEveryMs ?? 2));
          input.onProgress({
            index, total: input.preparation.sources.length, candidateId: item.candidateId, stage: 'merging',
            rowsDone: rowsWritten + Math.round((item.rows * step) / events), rowsTotal,
            ...(behavior.engineRemainingMs !== undefined ? { remainingMs: behavior.engineRemainingMs } : {})
          });
          if (behavior.cancelWhenMerging === index && step === 2) {
            ui.progress.find((entry) => entry.messages.some((message) => /^正在合并较大的旧聊天记录 /.test(message))).cancel();
          }
          if (input.signal.aborted) {
            call.abortedAt = index;
            cancelledHere = true;
            break;
          }
        }
        if (cancelledHere) {
          outcomes.push({ candidateId: item.candidateId, state: 'cancelled', code: 'runtime-data-set-merge-large-session-cancelled', message: '合并时取消了，这一份已撤回。' });
          continue;
        }
        rowsWritten += item.rows;
        outcomes.push({ candidateId: item.candidateId, state: 'merged', result: mergeResult(item.candidateId, 10 + index) });
      }
      return outcomes;
    }
  };
  const state = memento();
  if (behavior.requesterToken) void state.update('limcode.exclusiveMaintenance.requester', { 'historical-merge': behavior.requesterToken });
  const context = { workspaceState: state };
  const options = {
    report: async (batch, requested, details) => { reports.push([plain(batch), requested, details]); },
    engine,
    windowState: state,
    saveDrafts: () => 0,
    sessionId: behavior.sessionId ?? 'session-1',
    probeDisk: async () => ({
      device: 1, freeBytes: typeof behavior.freeBytes === 'function' ? behavior.freeBytes(host) : behavior.freeBytes ?? 1e13
    }),
    countdownSeconds: 2,
    ...(behavior.freshCause ? { freshCause: behavior.freshCause } : {})
  };
  return {
    ui, order, stages, ends, coordinations, reports, refusalQueries, host, engine, sources, state,
    offer: () => module.offerLargeHistoricalMerge(context, host, sources.map((item) => item.candidateId), options),
    start: () => module.startLargeHistoricalMerge(context, host, options)
  };
}

function loadSource(file, dependencies) {
  const ts = require('typescript');
  const filename = path.resolve(file);
  const module = { exports: {} };
  vm.runInNewContext(ts.transpileModule(fsSync.readFileSync(filename, 'utf8'), {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS }
  }).outputText, {
    module, exports: module.exports, console, setInterval, clearInterval, setTimeout, clearTimeout, Promise, AbortController,
    require(name) {
      if (!Object.prototype.hasOwnProperty.call(dependencies, name)) throw new Error(`Unexpected dependency ${name} of ${file}`);
      return dependencies[name];
    }
  }, { filename });
  return module.exports;
}

async function createRoot(t) {
  const parent = await fs.mkdtemp(path.join(os.tmpdir(), 'limcode-large-merge-'));
  t.after(() => fs.rm(parent, { recursive: true, force: true }));
  const root = path.join(parent, 'global');
  await fs.mkdir(root);
  const authority = new RootAuthority(() => resolveVscodeRuntimeDataRoot({ globalStoragePath: root }));
  const binding = await kernel.initializeEmptyRuntimeRoot(authority);
  return { root, binding, paths: binding.paths };
}
