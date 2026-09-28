// Large-merge session after the blind review (大库会话组): refused sources that no longer wait, the
// remaining time, the batch's room by the estimate's figures, the window's thread, full disks and
// temporary directories, the content verification cache, process identities, held backups, heartbeats.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { createRequire } from 'node:module';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {
  compiled, countRows, createConfigurationRoot, Database, generateSyntheticSource, kernel, kernelFile, ledgerEntries, NOW, rawWrite,
  readLedgerRecord, removeConfigurationRoot, saveState, seedConversations, seedRichSource
} from './fixtures/runtime-merge-fixture.mjs';

const require = createRequire(import.meta.url);
const fsPromises = require('node:fs/promises');
const {
  HISTORICAL_MERGE_ENGINE, mergeHistoricalDataSetsOnline, requestRuntimeDataSetMerge, RUNTIME_DATA_SET_MERGE_AWAITING_EXCLUSIVE
} = kernelFile('runtimeDataSetMerge.js');
const { ConversationDeletionControlPlane } = kernelFile('conversationDeletion.js');
const {
  estimateLargeMergeSources, largeMergeSkippedRows, LargeMergeSessionClock, prepareLargeMergeSources, releaseLargeMergePreparation,
  runLargeMergeSession
} = kernelFile('runtimeDataSetStreamedMerge.js');
const { sqliteTemporaryDirectory } = kernelFile('runtimeDataSetLargeMergeSpace.js');
const ledger = kernelFile('runtimeDataSetMergeLedger.js');
const { ownProcessStartIdentity } = kernelFile('runtimeClaimPrimitives.js');
const { openRuntimeCasVerificationCache } = kernelFile('runtimeCasVerificationCache.js');
const engineModule = kernelFile('runtimeLargeMergeEngine.js');
const { withRuntimeDataRootAdmission, withRuntimeMaintenance } = kernelFile('runtimeHostControl.js');
const { resolveVscodeRuntimeMergeLedgerRoot } = kernelFile('vscodeRootAuthority.js');
const LIMITS = { sizeLimits: { transactionRows: 50 }, chunkRows: 7 };
const MiB = 1024 * 1024;
const DISK_FULL = 'runtime-data-set-merge-disk-full';
const UNFINISHED = 'runtime-data-set-merge-unfinished-work';

// ---------------------------------------------------------------------------------------------
// #1 A large source with work no merge can close is refused, not left waiting.
// ---------------------------------------------------------------------------------------------

test('盲审 #1：超过在线上限、又有无法收尾的工作（仍在运行的后台进程）的来源，批次按受阻入账并写明原因（按缓存的审计判断的与新复制核验的都一样），不再列为“较大，等待合并”；估计判出不进会话的也从等待列表里去掉', { timeout: 300_000 }, async (t) => {
  const fixture = await fixtureFor(t, { beta: true });
  await seedRichSource(fixture.alpha, 'alpha', 3);
  await seedRichSource(fixture.beta, 'beta', 3);
  for (const dataSet of [fixture.alpha, fixture.beta]) {
    rawWrite(dataSet, (source) => {
      source.prepare(`INSERT INTO process VALUES (?, 'running', 'nonce', 1, NULL, NULL, 'fp', 'digest', 'spool', 0, 0, 0, 0, ?, ?, ?)`)
        .run(`${dataSet.id}_running_process`, NOW, NOW, NOW);
    });
    assert.ok(countRows(dataSet) > LIMITS.sizeLimits.transactionRows);
  }
  const engine = engineModule.largeMergeEngine();

  // The last batch left beta waiting (before its work began, say); the estimate settles it without a session
  // and caches its audit (the batch below judges beta by it, alpha by a new copy).
  engine.noteBatch(fixture.paths, batchOf({ deferred: [awaitingIssue(fixture.beta.id, 700)] }));
  assert.deepEqual((await engine.waiting(fixture.paths)).map((item) => item.candidateId), [fixture.beta.id]);
  const estimated = await withWindow(fixture, (window) => engine.estimate({
    paths: fixture.paths, target: { configurationRootPath: fixture.root, database: window }, candidateIds: [fixture.beta.id], requested: false
  }));
  assert.deepEqual(estimated.sources, []);
  assert.deepEqual(await engine.waiting(fixture.paths), [], '估计判出不进会话：不再列为等待');
  assert.deepEqual(await ledgerEntries(fixture, 'audits'), [`${fixture.beta.id.replace(/:/g, '-')}.json`], '只有 beta 的审计有缓存');

  for (const startup of [1, 2]) {
    const batch = await withWindow(fixture, (window) => mergeHistoricalDataSetsOnline(fixture.paths,
      { configurationRootPath: fixture.root, database: window }, { sizeLimits: LIMITS.sizeLimits }));
    engine.noteBatch(fixture.paths, batch);
    assert.deepEqual(batch.deferred, [], `第 ${startup} 次启动：不等待大库会话`);
    if (startup === 1) {
      assert.deepEqual(batch.blocked.map((issue) => [issue.candidateId, issue.code, issue.newly]).sort(),
        [[fixture.alpha.id, UNFINISHED, true], [fixture.beta.id, UNFINISHED, true]].sort());
      for (const issue of batch.blocked) assert.match(issue.message, /仍在运行或结果未知的后台进程×1/);
    }
    assert.deepEqual(await engine.waiting(fixture.paths), [], '“历史与存储管理”不列为较大、等待合并');
  }
  for (const dataSet of [fixture.alpha, fixture.beta]) {
    const record = await readLedgerRecord(fixture, dataSet.id);
    assert.equal(record?.state, 'blocked', '按受阻入账：列表显示原因与出路，和较小的来源一样');
  }
});

test('盲审 #1：以前合并进来的对话在当前库删掉了、无法收尾的工作只在这个对话里时，较大的来源不提前判受阻（批次与估计都是），照旧等大库会话；准备按剔除之后的工作照常准备', { timeout: 300_000 }, async (t) => {
  const fixture = await fixtureFor(t);
  const ids = await seedRichSource(fixture.alpha, 'alpha', 3);
  const first = await withWindow(fixture, (window) => mergeHistoricalDataSetsOnline(fixture.paths, { configurationRootPath: fixture.root, database: window }));
  assert.deepEqual(first.merged.map((item) => item.candidateId), [fixture.alpha.id]);
  // Deleted here as the deletion command deletes (its deletion record first).
  const tombstones = kernelFile('runtimeMergeTombstones.js');
  await withWindow(fixture, async (window) => {
    await tombstones.recordRuntimeDeletedConversations(fixture.root, window.binding, [ids[1]]);
    await new ConversationDeletionControlPlane(window).delete(ids[1]);
  });
  // Later in alpha: a new conversation, and the deleted one continued there, left waiting for an answer (no transition closes that).
  await seedConversations(fixture.alpha, [{ id: 'alpha_after_merge' }]);
  rawWrite(fixture.alpha, (source, contentId) => {
    source.prepare('INSERT INTO turn VALUES (?, ?, ?, ?, ?, ?)').run(`${ids[1]}_waiting_turn`, ids[1], 'active', NOW, NOW, null);
    source.prepare('INSERT INTO interaction_request VALUES (?, ?, ?, ?, ?, ?)').run(`${ids[1]}_question`, 'ask_user', 'pending', contentId, NOW, NOW);
    source.prepare('INSERT INTO interaction_owner_link VALUES (?, ?, ?, ?)').run(`${ids[1]}_question_owner`, `${ids[1]}_question`, `${ids[1]}_waiting_turn`, NOW);
  });
  await requestRuntimeDataSetMerge(fixture.paths, {
    candidateId: fixture.alpha.id, expectedDataSetId: fixture.alpha.binding.dataSetId, expectedRootInstanceId: fixture.alpha.binding.rootInstanceId
  });
  const batch = await withWindow(fixture, (window) => mergeHistoricalDataSetsOnline(fixture.paths,
    { configurationRootPath: fixture.root, database: window }, { candidateIds: [fixture.alpha.id], requested: true, sizeLimits: LIMITS.sizeLimits }));
  assert.deepEqual(batch.blocked, [], '不按审计里没剔除的工作判受阻');
  assert.deepEqual(batch.deferred.map((issue) => [issue.candidateId, issue.code]), [[fixture.alpha.id, RUNTIME_DATA_SET_MERGE_AWAITING_EXCLUSIVE]]);
  // The estimate judges it as the batch does: offered for the session, not told as refused.
  const estimate = await withWindow(fixture, (window) => estimateLargeMergeSources({
    paths: fixture.paths, target: { configurationRootPath: fixture.root, database: window }, candidateIds: [fixture.alpha.id], requested: true, options: LIMITS
  }));
  assert.deepEqual([estimate.sources.map((source) => source.candidateId), estimate.report.blocked], [[fixture.alpha.id], []]);
  const preparation = await withWindow(fixture, (window) => prepareLargeMergeSources({
    paths: fixture.paths, target: { configurationRootPath: fixture.root, database: window }, candidateIds: [fixture.alpha.id], requested: true, options: LIMITS
  }));
  try {
    assert.deepEqual(preparation.sources.map((source) => [source.candidateId, source.skippedConversations]), [[fixture.alpha.id, 1]]);
    assert.deepEqual([preparation.report.blocked, preparation.report.deferred], [[], []]);
  } finally {
    await releaseLargeMergePreparation(preparation);
  }
});

// ---------------------------------------------------------------------------------------------
// #2 The remaining time.
// ---------------------------------------------------------------------------------------------

test('盲审 #2：会话的剩余时间只按开始写入之后的速率算，不被每份开头的固定开销（副本、逐个 lstat、跳过闭包、账本）放大；写入不到 1 秒时用准备的估计', () => {
  // Two sources of 60,000 rows: 4 s of fixed work each, then 5 s of streaming (12 rows/ms).
  const sources = [
    { candidateId: 'a', rows: 60_000, estimateMs: 10_000 },
    { candidateId: 'b', rows: 60_000, estimateMs: 10_000 }
  ];
  let now = 0;
  const reports = [];
  const clock = new LargeMergeSessionClock({ sources }, (progress) => reports.push({ at: now, ...progress }), () => now);
  const end = 18_000;
  const at = (time, report) => { now = time; report(); };
  const a = clock.source(0, sources[0]);
  at(0, () => a('checking', 0));
  at(4_000, () => a('merging', 0));
  at(4_500, () => a('merging', 6_000));
  at(5_000, () => a('merging', 12_000));
  at(7_000, () => a('merging', 36_000));
  at(9_000, () => a('committing', 60_000));
  at(9_500, () => clock.sourceDone(sources[0]));
  const b = clock.source(1, sources[1]);
  at(9_500, () => b('checking', 0));
  at(13_000, () => b('merging', 0));
  at(15_500, () => b('merging', 30_000));
  const remaining = new Map(reports.map((report) => [report.at, report.remainingMs]));
  assert.equal(reports.length, 9);
  // Less than a second streamed: the preparation's estimates (the running source's less the time it ran).
  assert.equal(remaining.get(0), 20_000);
  assert.equal(remaining.get(4_000), 16_000);
  assert.equal(remaining.get(4_500), 15_500);
  // From then on the rate of streaming alone, plus a fixed part per source still to start.
  assert.equal(remaining.get(5_000), 13_000, '第一次按速率报：与实际剩余相同（按总用时算会是 45 秒）');
  for (const report of reports.filter((item) => item.at >= 5_000)) {
    const actual = end - report.at;
    assert.ok(Math.abs(report.remainingMs - actual) <= actual * 0.15 + 100, `${report.at} ms：报 ${report.remainingMs}，实际 ${actual}`);
  }
  // The session's rows stay counted as before.
  assert.deepEqual(reports.map((report) => report.sessionRows), [0, 0, 6_000, 12_000, 36_000, 60_000, 60_000, 60_000, 90_000]);
});

// ---------------------------------------------------------------------------------------------
// #3 The batch judges the session's room by the estimate's figures.
// ---------------------------------------------------------------------------------------------

test('盲审 #3：批次判断“放得下大库会话”用与估计相同的口径（随会话的中等来源也算、按文件字节与复制的正文）：估计说放不下时中等来源照常单独协调合并，放得下时随会话等待', { timeout: 300_000 }, async (t) => {
  const fixture = await fixtureFor(t, { beta: true });
  await seedConversations(fixture.alpha, [{ id: 'alpha_medium' }]);
  await seedRichSource(fixture.beta, 'beta', 3);
  const alphaRows = countRows(fixture.alpha);
  // alpha is above the online bound only (it goes along with a session); beta is above the in-memory bound (a session).
  const limits = { limits: { maxRows: alphaRows - 1, maxBytes: 1024 ** 4 }, sizeLimits: { transactionRows: alphaRows } };
  const coordinated = [];
  const coordinateOversized = async (input, run) => { coordinated.push(input.candidateId ?? input); await input.withLocks(run); return { state: 'completed' }; };
  const initial = await saveState(fixture, fixture.current);
  t.after(() => initial.remove());
  const decide = (free) => withWindow(fixture, async (window) => {
    const target = { configurationRootPath: fixture.root, database: window };
    // The estimate as the session's offer computes it (the medium source goes along), its disks as the window checks them.
    const estimate = await estimateLargeMergeSources({ paths: fixture.paths, target, threshold: 'online', options: limits });
    assert.deepEqual(estimate.sources.map((source) => source.candidateId).sort(), [fixture.alpha.id, fixture.beta.id].sort());
    // The largest source's private copy, and SQLite's temporary files at a quarter of it (#7).
    const largest = Math.max(...estimate.sources.map((source) => source.databaseBytes));
    assert.deepEqual([estimate.space.temporaryBytes, estimate.space.sqliteTemporaryBytes], [largest, Math.ceil(largest * 0.25)]);
    const needed = await neededOnOneDisk(estimate.space);
    const freeSpace = async () => needed + free;
    const short = await HISTORICAL_MERGE_ENGINE.largeMergeShortDisk(estimate.space, { freeSpace });
    const batch = await mergeHistoricalDataSetsOnline(fixture.paths, target, { ...limits, coordinateOversized, freeSpace });
    return { short, batch };
  });
  const cramped = await decide(-256 * 1024);
  assert.ok(cramped.short, '估计说放不下');
  assert.deepEqual(cramped.batch.merged.map((item) => item.candidateId), [fixture.alpha.id], '中等来源不被连带挡住');
  assert.deepEqual(cramped.batch.deferred.map((issue) => [issue.candidateId, issue.code]), [[fixture.beta.id, RUNTIME_DATA_SET_MERGE_AWAITING_EXCLUSIVE]]);
  assert.equal(coordinated.length, 1);
  await initial.restore();
  const roomy = await decide(256 * 1024);
  assert.equal(roomy.short, undefined, '估计说放得下');
  assert.deepEqual(roomy.batch.merged, []);
  assert.deepEqual(roomy.batch.deferred.map((issue) => [issue.candidateId, issue.code]).sort(),
    [[fixture.alpha.id, RUNTIME_DATA_SET_MERGE_AWAITING_EXCLUSIVE], [fixture.beta.id, RUNTIME_DATA_SET_MERGE_AWAITING_EXCLUSIVE]].sort());
  assert.equal(coordinated.length, 1, '随会话等待，不单独协调');
});

// ---------------------------------------------------------------------------------------------
// #4 Nothing of the preparation holds the window's thread.
// ---------------------------------------------------------------------------------------------

test('盲审 #4：跨几张表的“全部成员都跳过”规则按候选分步跑、每步之后让出线程，闭包与在线合并的 skippedRows 逐条相同（链到别的对话的消息、上下文节点与片段不误跳，自引用的节点链也一样）', { timeout: 300_000 }, async (t) => {
  const fixture = await fixtureFor(t);
  await generateSyntheticSource(fixture.alpha, { rows: 630, prefix: 'closure' });
  const rich = await seedRichSource(fixture.alpha, 'rich', 3);
  const conversations = Array.from({ length: 10 }, (_, index) => `closure_${String(index).padStart(7, '0')}`);
  rawWrite(fixture.alpha, (source, contentId) => {
    const insert = (table, row) => source.prepare(`INSERT INTO ${table} (${Object.keys(row).join(', ')}) VALUES (${Object.keys(row).map(() => '?').join(', ')})`)
      .run(...Object.values(row));
    // Messages of conversations 0 and 2 linked to a Turn of conversations 1 and 3 (a message belongs to one conversation).
    insert('message_turn_link', { id: 'cross_turn_link_0', turn_id: `${conversations[1]}_turn`, message_id: `${conversations[0]}_m0`, role: 'user', created_at: NOW });
    insert('message_turn_link', { id: 'cross_turn_link_2', turn_id: `${conversations[3]}_turn`, message_id: `${conversations[2]}_m0`, role: 'user', created_at: NOW });
    // Context sequences: node_1's parent is node_0 (conversation 0's root), a compression of conversation 2 reads segment_0.
    for (const index of [0, 1]) {
      insert('context_segment', { id: `segment_${index}`, content_object_id: contentId, segment_kind: 'message', created_at: NOW });
      insert('context_sequence_node', { id: `node_${index}`, parent_node_id: index === 1 ? 'node_0' : null, segment_id: `segment_${index}`, created_at: NOW });
      insert('context_sequence_root', {
        id: `root_${index}`, conversation_id: conversations[index], root_seq: 1, root_node_id: `node_${index}`, tail_node_id: `node_${index}`,
        tail_segment_count: 1, segment_count: 1, estimated_tokens: 10, created_at: NOW
      });
    }
    insert('compression_block', {
      id: 'block_2', conversation_id: conversations[2], status: 'active', authority_snapshot_id: 'snapshot', title_object_id: contentId,
      summary_object_id: contentId, created_at: NOW, updated_at: NOW
    });
    insert('compression_block_source', { id: 'block_2_source', compression_block_id: 'block_2', segment_id: 'segment_0', position: 0, created_at: NOW });
  });
  const source = new Database(fixture.alpha.binding.paths.databasePath, { readonly: true });
  t.after(() => source.close());
  const flatten = (map) => [...map].flatMap(([domain, ids]) => [...ids].map((id) => `${domain}:${id}`)).sort();
  const skippedIn = (list, domain, id) => list.includes(`${domain}:${id}`);
  const cases = [[0], [1], [0, 1], [2], [0, 1, 2, 3], conversations.slice(4), [...conversations, ...rich]];
  for (const deleted of cases.map((entry) => entry.map((item) => typeof item === 'number' ? conversations[item] : item))) {
    const expected = flatten(HISTORICAL_MERGE_ENGINE.skippedRows(source, new Set(deleted)));
    for (const segmentRows of [1, 3, 1_000]) {
      const pauses = { rule: 0, all: 0 };
      const actual = flatten(await largeMergeSkippedRows(source, deleted, segmentRows, async (step) => { pauses[step] += 1; }));
      assert.deepEqual(actual, expected, `删掉 ${deleted.join('、')}，每段 ${segmentRows} 行`);
      if (segmentRows === 1) {
        const members = expected.filter((entry) => entry.startsWith('MessagePartOfConversation:')).length;
        assert.ok(pauses.all >= members, `“全部成员”规则每一步都让出线程：${pauses.all} 次，跳过的成员 ${members} 条`);
      }
    }
    const only = (index) => deleted.length === 1 && deleted[0] === conversations[index];
    if (only(0)) {
      assert.equal(skippedIn(expected, 'Message', `${conversations[0]}_m1`), true);
      assert.equal(skippedIn(expected, 'Message', `${conversations[0]}_m0`), false, '链到对话 1 的 Turn 的消息不跳');
      assert.equal(skippedIn(expected, 'ContextSequenceNode', 'node_0'), false, '还是 node_1 的父节点');
      assert.equal(skippedIn(expected, 'ContextSegment', 'segment_0'), false);
    }
    if (only(1)) {
      assert.equal(skippedIn(expected, 'ContextSequenceNode', 'node_1'), true);
      assert.equal(skippedIn(expected, 'ContextSegment', 'segment_1'), true);
      assert.equal(skippedIn(expected, 'ContextSequenceNode', 'node_0'), false);
    }
    if (only(2)) assert.equal(skippedIn(expected, 'Message', `${conversations[2]}_m0`), false, '链到对话 3 的 Turn 的消息不跳');
  }
});

test('盲审 #4：准备在目标备份上量索引页（dbstat）放在审计线程里，窗口线程上不跑', { timeout: 300_000 }, async (t) => {
  const fixture = await fixtureFor(t);
  await seedRichSource(fixture.current, 'target', 6);
  await seedRichSource(fixture.alpha, 'alpha', 3);
  const SqliteDatabase = require(require.resolve('better-sqlite3', { paths: [path.join(compiled, 'backend/reliableKernel')] }));
  const prepare = SqliteDatabase.prototype.prepare;
  t.after(() => { SqliteDatabase.prototype.prepare = prepare; });
  const onThisThread = [];
  SqliteDatabase.prototype.prepare = function recordDbstat(sql, ...rest) {
    if (typeof sql === 'string' && /\bdbstat\b/.test(sql)) onThisThread.push(sql);
    return prepare.call(this, sql, ...rest);
  };
  let preparation;
  try {
    preparation = await withWindow(fixture, (window) => prepareLargeMergeSources({
      paths: fixture.paths, target: { configurationRootPath: fixture.root, database: window }, options: LIMITS
    }));
  } finally {
    SqliteDatabase.prototype.prepare = prepare;
  }
  try {
    assert.equal(preparation.sources.length, 1);
    assert.deepEqual(onThisThread, [], '窗口线程上没有 dbstat');
    const measured = await indexBytesOf(path.join(preparation.backupPath, 'limcode.sqlite'));
    assert.ok(measured > 0);
    assert.equal(preparation.space.targetIndexBytes, measured, '照样在备份上实测');
  } finally {
    await releaseLargeMergePreparation(preparation);
  }
});

// ---------------------------------------------------------------------------------------------
// #5 and #7 Full disks: said in Chinese, with the directory that is full.
// ---------------------------------------------------------------------------------------------

test('盲审 #5：写准备记录遇到磁盘满时按磁盘空间不足推迟（中文、写明目录、没有系统原文），后面的来源不开始；错误没说文件时，写满的是数据库临时文件目录就写它（#7）', { timeout: 300_000 }, async (t) => {
  const fixture = await fixtureFor(t, { beta: true });
  await seedRichSource(fixture.alpha, 'alpha', 3);
  await seedRichSource(fixture.beta, 'beta', 3);
  const sqliteTemporary = await sqliteTemporaryDirectory();
  const open = fsPromises.open;
  t.after(() => { fsPromises.open = open; });
  for (const named of [true, false]) {
    let claims = 0;
    fsPromises.open = async (file, ...rest) => {
      if (String(file).includes(`${path.sep}preparing${path.sep}`) && String(file).endsWith('.tmp') && ++claims === 1) {
        throw named
          ? Object.assign(new Error(`ENOSPC: no space left on device, open '${file}'`), { code: 'ENOSPC', syscall: 'open', path: String(file) })
          : Object.assign(new Error('database or disk is full'), { code: 'SQLITE_FULL' });
      }
      return open(file, ...rest);
    };
    // Where the error names no file: the target's disk has room, SQLite's temporary directory not.
    const freeSpace = async (directory) => (!named && path.resolve(directory) === path.resolve(sqliteTemporary) ? 8 * MiB : 1024 * 1024 * MiB);
    let preparation;
    try {
      preparation = await withWindow(fixture, (window) => prepareLargeMergeSources({
        paths: fixture.paths, target: { configurationRootPath: fixture.root, database: window }, options: { ...LIMITS, freeSpace }
      }));
    } finally {
      fsPromises.open = open;
    }
    assert.deepEqual(preparation.sources, []);
    const [first, later] = preparation.report.deferred;
    assert.deepEqual(preparation.report.deferred.map((issue) => issue.code), [DISK_FULL, DISK_FULL]);
    const where = named ? path.join(resolveVscodeRuntimeMergeLedgerRoot(fixture.paths), 'preparing') : sqliteTemporary;
    assert.equal(first.message, `磁盘空间不足：准备合并这份旧聊天记录时在 ${where} 写不下了，这次没有合并；腾出空间后会再合并`);
    assert.doesNotMatch(first.message, /ENOSPC|SQLITE|no space|disk is full/u, '没有系统原文');
    assert.equal(later.message, '前一份准备时磁盘空间不足，这一份没有开始；腾出空间后会再合并。');
    assert.deepEqual(await ledgerEntries(fixture, 'preparing'), []);
    assert.deepEqual(await backupNames(fixture), []);
  }
});

test('盲审 #7：会话的事务遇到磁盘满（SQLite 的错误不说文件）而当前库所在的盘还有空间、数据库临时文件目录不到余量：说的是那个目录和它要的量，不让用户去腾当前库的盘', { timeout: 300_000 }, async (t) => {
  const fixture = await fixtureFor(t);
  await seedRichSource(fixture.alpha, 'alpha', 3);
  const sqliteTemporary = await sqliteTemporaryDirectory();
  const preparation = await withWindow(fixture, (window) => prepareLargeMergeSources({
    paths: fixture.paths, target: { configurationRootPath: fixture.root, database: window }, options: LIMITS
  }));
  assert.equal(preparation.sources.length, 1);
  const open = fsPromises.open;
  let full = false;
  fsPromises.open = async (file, ...rest) => {
    if (full && String(file).includes(`${path.sep}commits${path.sep}`)) throw Object.assign(new Error('database or disk is full'), { code: 'SQLITE_FULL' });
    return open(file, ...rest);
  };
  t.after(() => { fsPromises.open = open; });
  const freeSpace = async (directory) => (full && path.resolve(directory) === path.resolve(sqliteTemporary) ? 8 * MiB : 1024 * 1024 * MiB);
  const session = await withRuntimeDataRootAdmission(fixture.root, () => withRuntimeMaintenance(fixture.current.binding.paths,
    () => runLargeMergeSession({
      paths: fixture.paths, prepared: preparation,
      options: { freeSpace, onFaultPoint: (point) => { if (point === 'after-last-chunk') full = true; } }
    })));
  fsPromises.open = open;
  assert.deepEqual(session.results.map((result) => [result.state, result.issue?.code]), [['deferred', DISK_FULL]]);
  const { message } = session.results[0].issue;
  const match = /^磁盘空间不足，需要约 (\d+) MB：合并这份旧聊天记录要在数据库临时文件目录（(.+)）暂存数据，已撤回这份的写入$/u.exec(message);
  assert.ok(match, message);
  assert.equal(match[2], sqliteTemporary);
  assert.ok(Number(match[1]) >= 64, '需要量按临时目录一侧（其中含余量）');
  assert.equal(await readLedgerRecord(fixture, fixture.alpha.id), undefined);
  assert.deepEqual(await ledgerEntries(fixture, 'commits'), []);
});

// ---------------------------------------------------------------------------------------------
// #6 The content verification cache.
// ---------------------------------------------------------------------------------------------

test('盲审 #6：正文核验缓存一次批量写入失败（另一个进程占着它的写锁）：丢掉的条目计入没记下的，准备如实推迟这份来源，不留备份和声明', { timeout: 300_000 }, async (t) => {
  const fixture = await fixtureFor(t);
  await seedRichSource(fixture.alpha, 'alpha', 3);
  const file = path.join(resolveVscodeRuntimeMergeLedgerRoot(fixture.paths), 'limcode.cas-verified.sqlite');
  (await openRuntimeCasVerificationCache(fixture.root)).close();
  await fs.access(file);
  const holder = await holdWriteLock(t, file);
  const preparation = await withWindow(fixture, (window) => prepareLargeMergeSources({
    paths: fixture.paths, target: { configurationRootPath: fixture.root, database: window }, options: LIMITS
  }));
  await holder.stop();
  assert.deepEqual(preparation.sources, [], '不进会话');
  assert.deepEqual(preparation.report.deferred.map((issue) => issue.code), ['runtime-data-set-merge-verification-unrecorded']);
  assert.deepEqual(await backupNames(fixture), []);
  assert.deepEqual(await ledgerEntries(fixture, 'preparing'), []);
  assert.equal(await readLedgerRecord(fixture, fixture.alpha.id), undefined, '不入账，以后再合并');
  // With the lock gone the next preparation records them and goes on.
  const again = await withWindow(fixture, (window) => prepareLargeMergeSources({
    paths: fixture.paths, target: { configurationRootPath: fixture.root, database: window }, options: LIMITS
  }));
  assert.equal(again.sources.length, 1);
  await releaseLargeMergePreparation(again);
});

// ---------------------------------------------------------------------------------------------
// #8 #9 F7 Records of windows: process identities, held backups, heartbeats.
// ---------------------------------------------------------------------------------------------

test('盲审 #8：准备记录与目标备份登记的存活判定带进程启动身份：pid 还在但启动身份不同（pid 被复用）就算不在', () => {
  const identity = ownProcessStartIdentity();
  assert.equal(typeof identity, 'string');
  const now = new Date().toISOString();
  const preparation = { candidateId: 'workspace:x', token: 'token', processId: process.pid, startedAt: now, heartbeatAt: now };
  const backup = { name: '20260928T000000000Z-000001-aaaaaaaa', backupPath: '/b', processId: process.pid, startedAt: now, heartbeatAt: now, used: false };
  for (const [live, record] of [[ledger.isRuntimeDataSetMergePreparationLive, preparation], [ledger.isRuntimeLargeMergeTargetBackupLive, backup]]) {
    assert.equal(live(record), true, '没记启动身份：按 pid');
    assert.equal(live({ ...record, processStartIdentity: identity }), true);
    assert.equal(live({ ...record, processStartIdentity: `${identity}-reused` }), false, 'pid 被复用');
  }
});

test('盲审 #9：裁剪目标备份时，仍有存活准备登记的备份（那个窗口可能正在等协调）不删、也不占保留名额', { timeout: 300_000 }, async (t) => {
  const fixture = await fixtureFor(t);
  await seedConversations(fixture.alpha, [{ id: 'alpha_small' }]);
  const backups = backupsDirectory(fixture);
  const held = '20260101T000000000Z-000001-aaaaaaaa';
  const old = ['20260102T000000000Z-000001-bbbbbbbb', '20260103T000000000Z-000001-cccccccc', '20260104T000000000Z-000001-dddddddd'];
  for (const name of [held, ...old]) await fs.mkdir(path.join(backups, name), { recursive: true });
  const now = new Date().toISOString();
  await ledger.writeRuntimeLargeMergeTargetBackup({ globalStoragePath: fixture.root }, {
    name: held, backupPath: path.join(backups, held), processId: process.pid, processStartIdentity: ownProcessStartIdentity(),
    startedAt: now, heartbeatAt: now, used: false
  });
  const batch = await withWindow(fixture, (window) => mergeHistoricalDataSetsOnline(fixture.paths, { configurationRootPath: fixture.root, database: window }));
  assert.deepEqual(batch.merged.map((item) => item.candidateId), [fixture.alpha.id]);
  const own = path.basename(batch.merged[0].backupPath);
  assert.deepEqual(await backupNames(fixture), [held, ...old.slice(1), own].sort(), '登记的那份留着，其余按保留数裁剪');
});

test('F7：准备记录的心跳在配置准入内核对后才写回——读到记录之后释放才来，释放等心跳写完再删，记录不会被写回；记录已换成别的窗口的，心跳不碰它、释放也不删', { timeout: 300_000 }, async (t) => {
  const fixture = await fixtureFor(t);
  await seedRichSource(fixture.alpha, 'alpha', 3);
  let armed = false;
  let reached;
  const heartbeat = new Promise((resolve) => { reached = resolve; });
  let resume;
  const resumed = new Promise((resolve) => { resume = resolve; });
  const onFaultPoint = async (point, detail) => {
    if (point !== 'preparation-heartbeat' || !armed) return;
    armed = false;
    reached(detail);
    await resumed;
  };
  const preparation = await withWindow(fixture, (window) => prepareLargeMergeSources({
    paths: fixture.paths, target: { configurationRootPath: fixture.root, database: window }, options: { ...LIMITS, heartbeatMs: 20, onFaultPoint }
  }));
  assert.equal(preparation.sources.length, 1);
  armed = true;
  assert.equal((await heartbeat).candidateId, fixture.alpha.id);
  // The heartbeat read the record and found it still this window's; the release comes now.
  const releasing = releaseLargeMergePreparation(preparation);
  await delay(300);
  resume();
  await releasing;
  await delay(100);
  assert.deepEqual(await ledgerEntries(fixture, 'preparing'), [], '释放之后记录没有被心跳写回');

  // Another window took the record over (a new token): this window's heartbeats leave it as it is.
  const second = await withWindow(fixture, (window) => prepareLargeMergeSources({
    paths: fixture.paths, target: { configurationRootPath: fixture.root, database: window }, options: { ...LIMITS, heartbeatMs: 20 }
  }));
  assert.equal(second.sources.length, 1);
  const theirs = {
    candidateId: fixture.alpha.id, token: `other-${randomUUID()}`, processId: process.pid, startedAt: NOW, heartbeatAt: '2026-09-01T00:00:00.000Z'
  };
  await withRuntimeDataRootAdmission(fixture.root, () => ledger.writeRuntimeDataSetMergePreparation(fixture.paths, theirs));
  await delay(200);
  const kept = await ledger.readRuntimeDataSetMergePreparation(fixture.paths, fixture.alpha.id);
  assert.deepEqual([kept.token, kept.heartbeatAt], [theirs.token, theirs.heartbeatAt], '别的窗口的记录没被刷新或覆盖');
  await releaseLargeMergePreparation(second);
  assert.equal((await ledger.readRuntimeDataSetMergePreparation(fixture.paths, fixture.alpha.id))?.token, theirs.token, '释放不删别的窗口的记录');
  await ledger.removeRuntimeDataSetMergePreparation(fixture.paths, fixture.alpha.id);
});

// ---------------------------------------------------------------------------------------------
// Helpers.
// ---------------------------------------------------------------------------------------------

async function fixtureFor(t, options) {
  const fixture = await createConfigurationRoot(options);
  t.after(() => removeConfigurationRoot(fixture.root));
  return fixture;
}

async function withWindow(fixture, run) {
  const window = await kernel.RuntimeDatabase.open(fixture.current.authority, { hostBootId: `window-${randomUUID()}` });
  try { return await run(window); } finally { await window.close(); }
}

function batchOf(overrides) {
  return { merged: [], deferred: [], blocked: [], failures: [], pendingSources: 0, stopped: false, ...overrides };
}

function awaitingIssue(candidateId, rows) {
  return { candidateId, code: RUNTIME_DATA_SET_MERGE_AWAITING_EXCLUSIVE, message: '等待', newly: true, size: { rows, bytes: rows * 100 } };
}

/** What a session needs when the target's disk, the temporary directory and SQLite's are one disk (as in this test run). */
async function neededOnOneDisk(space) {
  const devices = new Set(await Promise.all([space.targetDirectory, space.temporaryDirectory, space.sqliteTemporaryDirectory]
    .map(async (directory) => (await fs.stat(directory)).dev)));
  assert.equal(devices.size, 1, '这个测试假定都在同一块盘上');
  return space.targetBytes + space.temporaryBytes + space.sqliteTemporaryBytes;
}

function backupsDirectory(fixture) {
  return path.join(path.dirname(fixture.current.binding.paths.dataRootPath), 'merge-backups');
}

async function backupNames(fixture) {
  return (await fs.readdir(backupsDirectory(fixture)).catch(() => [])).sort();
}

/** Index pages of a database file (dbstat), read from a private copy so the file itself gets no sidecars. */
async function indexBytesOf(file) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'limcode-large-merge-blind-index-'));
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

/**
 * Another process holding the write lock of an SQLite file (BEGIN IMMEDIATE) until stopped: this
 * process never opens the file itself (POSIX locks, see AGENTS.md).
 */
async function holdWriteLock(t, file) {
  const sqlite = require.resolve('better-sqlite3', { paths: [path.join(compiled, 'backend/reliableKernel')] });
  const child = spawn(process.execPath, ['-e', `
    const Database = require(process.argv[1]);
    const database = new Database(process.argv[2]);
    database.exec('BEGIN IMMEDIATE');
    process.stdout.write('locked\\n');
    process.stdin.resume();
    process.stdin.on('end', () => { database.exec('ROLLBACK'); database.close(); process.exit(0); });
  `, sqlite, file], { stdio: ['pipe', 'pipe', 'inherit'] });
  const exited = new Promise((resolve) => child.once('exit', resolve));
  t.after(async () => { if (child.exitCode === null) { child.kill('SIGKILL'); await exited; } });
  await new Promise((resolve, reject) => {
    child.stdout.on('data', (chunk) => { if (String(chunk).includes('locked')) resolve(); });
    child.once('exit', (code) => reject(new Error(`锁住核验缓存的进程退出了（${code}）`)));
  });
  return { stop: async () => { child.stdin.end(); await exited; } };
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
