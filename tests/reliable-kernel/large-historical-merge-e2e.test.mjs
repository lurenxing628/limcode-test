// End to end: the large merge session (大库会话) with the real engine. Every window is its own process:
// large-historical-merge-window.mjs opens the full production Runtime composition (only the model
// Provider is synthetic, and every call to it is recorded) and runs the real startup flow and the
// manual entry of runtimeDataSetManagement.ts / largeHistoricalMerge.ts; runtime-exclusive-maintenance-
// window.mjs is another window that only takes part. The sources are written through Repositories
// (A1's fixture); one of them was left by an old window killed in the middle of a Turn; one is a
// foreign history root (a copied data directory) the user asked to merge.
import assert from 'node:assert/strict';
import { execFile, spawn } from 'node:child_process';
import fsSync from 'node:fs';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import {
  compiled, createConfigurationRoot, Database, generateSyntheticSource, initializeScope, kernelFile, ledgerEntries, readAll,
  readLedgerRecord, saveState, sha256, treeSnapshot
} from './fixtures/runtime-merge-fixture.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const {
  MERGE_FINALIZATION_REASON, RUNTIME_DATA_SET_MERGE_AWAITING_EXCLUSIVE, RUNTIME_DATA_SET_MERGE_BACKUPS_DIRECTORY,
  RUNTIME_DATA_SET_MERGE_SOURCE_BACKUPS_DIRECTORY
} = kernelFile('runtimeDataSetMerge.js');
const {
  claimLargeMergePrompt, formatLargeMergeAbout, formatLargeMergeRowsWithUnit, largeMergeCountdownText, largeMergeWaitingText
} = kernelFile('runtimeLargeMergeSession.js');
const foreign = kernelFile('runtimeForeignHistory.js');
const foreignMerge = kernelFile('runtimeForeignHistoryMerge.js');
const { resolveVscodeRuntimeMergeLedgerRoot } = kernelFile('vscodeRootAuthority.js');
const { createConversationRuntimeWorkProbe } = kernelFile('conversationRuntimePendingWork.js');
const SCRIPTS = {
  large: path.join(HERE, 'large-historical-merge-window.mjs'),
  participant: path.join(HERE, 'runtime-exclusive-maintenance-window.mjs')
};
const LARGE_ROWS = 61_000;
const MEDIUM_ROWS = 5_000;
// generateSyntheticSource writes 63 rows per conversation.
const CONVERSATIONS = (rows) => Math.ceil(rows / 63);
const MERGED_TEXT = (sources, conversations, finalized) => `已把 ${sources} 份较大的旧聊天记录合并到当前历史库（新增 ${conversations} 个对话），可直接在侧栏继续。`
  + (finalized ? '其中 1 个中断的任务已按“中止”收尾，不会被继续执行。另有 1 条排队未发送的消息已取消。' : '') + '原库和合并前备份都已保留。';
const PROBLEMS = ['failed', 'unhandled', 'error-message'];
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

test('大库会话端到端（自动流程，真实引擎，只假 Provider）：带中断 Turn 的大库与一份中等来源在启动批次里一起等待；只读估计（按批次缓存的审计）、倒计时（写明后台准备与暂停两段时长）、倒计时结束后才在线准备（收尾中断任务）、与另一个窗口协调（不可否决的倒计时）、关闭运行时、会话、重载、结果提示依次发生；之后两次打开当前库 Provider 调用都为 0', { timeout: 300_000 }, async (t) => {
  const env = await environment(t, { beta: true });
  const { fixture, windows } = env;
  await generateSyntheticSource(fixture.alpha, { rows: LARGE_ROWS, prefix: 'alpha' });
  // Above the online bound, below the in-memory one: it goes along with the session.
  await generateSyntheticSource(fixture.beta, { rows: MEDIUM_ROWS, prefix: 'beta' });
  await crashSource(env, fixture.alpha);

  windows.start('W', 'participant', { noMerge: true }, { restartOnReload: true });
  await windows.waitFor('W', 'ready');
  windows.start('R', 'large', env.state);
  const exited = await windows.waitFor('R', 'exit', { boot: 1, timeoutMs: 180_000 });
  assert.equal(exited.code, 0, windows.stderr('R'));
  await reopenTwice(env, 2);
  await windows.waitFor('W', 'ready', { boot: 2, timeoutMs: 60_000 });
  await windows.stop();
  const r1 = windows.of('R', 1);
  assert.deepEqual(r1.filter((event) => PROBLEMS.includes(event.event)), []);

  assertBatchLeftBoth(fixture, first(r1, 'batch'));
  // Read-only first, in the status bar: judged from the audits the startup batch cached (nothing copied again).
  const estimated = first(r1, 'estimated');
  assertEstimated(fixture, estimated, { cached: true });
  assert.ok(first(r1, 'progress', (item) => item.title === '正在估计合并较大的旧聊天记录需要多久' && item.location === 10), '估计在状态栏进行');
  // The countdown names both parts the estimate gave: the background preparation after it, then the pause of every window.
  const countdown = first(r1, 'progress-report', (item) => /^将在 1 秒后合并 2 份较大的旧聊天记录（约 [\d.]+ 万条）。倒计时结束后先在后台准备.+（期间照常可用），准备好后所有 LimCode 窗口重载一次，暂停.+（显示进度，完成后自动恢复，未发送的输入会保留）。点“取消”改到下次启动。$/.test(item.message));
  assert.ok(countdown, r1.filter((item) => item.event === 'progress-report').map((item) => item.message).join('\n'));
  assert.equal(countdown.message, countdownText(estimated, 1));
  // Only once the countdown ran out: prepared online (a notification that can be cancelled) while the window stayed usable —
  // the crashed Turn closed, compared, the target backed up.
  const preparing = first(r1, 'preparing');
  assert.deepEqual(preparing.candidateIds.sort(), estimated.sources.map((source) => source.candidateId).sort());
  const prepared = first(r1, 'prepared');
  assertPrepared(fixture, prepared);
  assert.ok(first(r1, 'progress', (item) => item.title === '正在准备合并较大的旧聊天记录（窗口照常可用）' && item.location === 15 && item.cancellable));
  assertPreparationReports(r1.filter((item) => item.event === 'progress-report' && item.title === '正在准备合并较大的旧聊天记录（窗口照常可用）'));
  // The estimate gave the preparation's fingerprints: the medium source's is the same; the large one changed as its unfinished work was closed.
  const fingerprint = (event, dataSet) => event.sources.find((source) => source.candidateId === dataSet.id).fingerprint;
  assert.equal(fingerprint(prepared, fixture.beta), fingerprint(estimated, fixture.beta));
  assert.notEqual(fingerprint(prepared, fixture.alpha), fingerprint(estimated, fixture.alpha));
  // The coordination: the other window counted down without a cancel and reloaded once.
  assert.equal(first(windows.of('W', 1), 'progress', (item) => item.countdown)?.cancellable, false, '其它窗口不可否决');
  assert.equal(windows.events().filter((event) => event.name === 'W' && event.event === 'reload').length, 1, '只协调了一次（中等来源没有单独协调）');
  assertSessionOrder(windows, r1, [estimated.at, countdown.at, preparing.at, prepared.at]);
  await assertMergedAfterReload(t, env, 2, { sources: 2, conversations: CONVERSATIONS(LARGE_ROWS) + 1 + CONVERSATIONS(MEDIUM_ROWS), finalized: true });
  await assertTargetMerged(env, [fixture.alpha, fixture.beta], CONVERSATIONS(LARGE_ROWS) + 1 + CONVERSATIONS(MEDIUM_ROWS));
});

test('大库会话端到端（手动流程）：历史与存储管理里按批次测得的规模开始，先只读估计、再按估计的两段时长确认、确认之后才在后台准备（可取消的通知），其它窗口只收到提示；会话进行中不对这次点击说“没有合并”；会话、重载、结果提示；之后两次打开 Provider 调用都为 0', { timeout: 300_000 }, async (t) => {
  const env = await environment(t, { beta: true });
  const { fixture, windows } = env;
  await generateSyntheticSource(fixture.alpha, { rows: LARGE_ROWS, prefix: 'alpha' });
  await generateSyntheticSource(fixture.beta, { rows: MEDIUM_ROWS, prefix: 'beta' });
  await crashSource(env, fixture.alpha);
  await holdStartupPrompt(fixture);

  windows.start('W', 'participant', { noMerge: true }, { restartOnReload: true });
  await windows.waitFor('W', 'ready');
  windows.start('R', 'large', { ...env.state, manual: 'menu' });
  const exited = await windows.waitFor('R', 'exit', { boot: 1, timeoutMs: 180_000 });
  assert.equal(exited.code, 0, windows.stderr('R'));
  await reopenTwice(env, 2);
  await windows.waitFor('W', 'ready', { boot: 2, timeoutMs: 60_000 });
  await windows.stop();
  const r1 = windows.of('R', 1);
  assert.deepEqual(r1.filter((event) => PROBLEMS.includes(event.event)), []);

  const batch = first(r1, 'batch');
  assertBatchLeftBoth(fixture, batch);
  // The startup prompt is another window's: nothing is estimated, prepared or counted down here before the user asks.
  assert.equal(r1.filter((item) => item.event === 'estimated').length, 1);
  assert.equal(r1.filter((item) => item.event === 'prepared').length, 1);
  assert.equal(first(r1, 'progress-report', (item) => /^将在/.test(item.message)), undefined);
  // The menu gives the size the batch measured, and no made-up duration.
  const rows = batch.deferred.reduce((sum, item) => sum + item.rows, 0);
  const menu = first(r1, 'quick-pick', (item) => item.placeHolder === '历史与存储管理');
  assert.ok(menu.labels.includes(`合并较大的旧聊天记录（2 份，${largeMergeWaitingText(rows)}）`), menu.labels.join('\n'));
  // Estimated read-only (a notification that can be cancelled) from the audits the batch cached, then confirmed with both durations.
  assert.ok(first(r1, 'progress', (item) => item.title === '正在估计合并较大的旧聊天记录需要多久（只读，窗口照常可用）' && item.cancellable && item.location === 15));
  const estimated = first(r1, 'estimated');
  assertEstimated(fixture, estimated, { cached: true });
  assert.equal(estimated.sources.reduce((sum, source) => sum + source.rows, 0), rows, '估计与批次测得的规模一致');
  const confirm = first(r1, 'warning', (item) => item.modal);
  assert.equal(confirm.message, `合并较大的旧聊天记录（2 份，约 ${formatLargeMergeRowsWithUnit(rows)}记录）？`);
  assert.ok(confirm.detail.startsWith(`先在后台准备${formatLargeMergeAbout(estimated.preparing)}（窗口照常可用，可以取消），再等本窗口和其它 LimCode 窗口的任务结束（最多约 10 分钟），`
    + `然后所有 LimCode 窗口重载一次，暂停${formatLargeMergeAbout(estimated.duration)}：`), confirm.detail);
  // Nothing was settled by the estimate or the preparation: the click hears back only with the session's result.
  assert.deepEqual(r1.filter((item) => item.event === 'notice' && /没有合并/.test(item.message)), []);
  const prepared = first(r1, 'prepared');
  assertPrepared(fixture, prepared);
  assert.ok(first(r1, 'progress', (item) => item.title === '正在准备合并较大的旧聊天记录（窗口照常可用）' && item.cancellable && item.location === 15));
  assertPreparationReports(r1.filter((item) => item.event === 'progress-report' && item.title === '正在准备合并较大的旧聊天记录（窗口照常可用）'));
  // The user confirmed here: the other window was only told, without a countdown.
  const w1 = windows.of('W', 1);
  assert.ok(first(w1, 'notice', (item) => item.message === '为合并较大的旧聊天记录，本窗口将重载；未发送的输入会保留。'));
  assert.equal(first(w1, 'progress', (item) => item.countdown), undefined);
  assert.equal(windows.events().filter((event) => event.name === 'W' && event.event === 'reload').length, 1);
  assertSessionOrder(windows, r1, [menu.at, estimated.at, confirm.at, prepared.at]);
  await assertMergedAfterReload(t, env, 2, { sources: 2, conversations: CONVERSATIONS(LARGE_ROWS) + 1 + CONVERSATIONS(MEDIUM_ROWS), finalized: true });
  await assertTargetMerged(env, [fixture.alpha, fixture.beta], CONVERSATIONS(LARGE_ROWS) + 1 + CONVERSATIONS(MEDIUM_ROWS));
});

test('大库会话端到端：会话中途 SIGKILL（事务已写入若干块）后，下次启动按提交证据收敛再重新合并：当前库与一次不中断的合并逐行相同（不重复插入、不丢），中断任务的收尾照样说明，之后两次打开 Provider 调用为 0', { timeout: 300_000 }, async (t) => {
  const env = await environment(t, {});
  const { fixture, windows } = env;
  await generateSyntheticSource(fixture.alpha, { rows: LARGE_ROWS, prefix: 'alpha' });
  await crashSource(env, fixture.alpha);
  await holdStartupPrompt(fixture);
  const initial = await saveState(fixture, fixture.current);
  env.cleanup.push(() => initial.remove());

  windows.start('R', 'large', { ...env.state, manual: 'menu', killAt: { index: 0, merging: 3 } });
  const killed = await windows.waitFor('R', 'exit', { boot: 1, timeoutMs: 180_000 });
  assert.equal(killed.signal, 'SIGKILL', windows.stderr('R'));
  const killing = first(windows.of('R', 1), 'killing');
  assert.ok(killing && killing.rowsDone > 0, JSON.stringify(killing));
  // What the dead session left: its commit evidence, its committing record, its private copy.
  assert.equal((await readLedgerRecord(fixture, fixture.alpha.id))?.state, 'committing');
  assert.equal((await ledgerEntries(fixture, 'commits')).length, 1);
  assert.ok((await leftovers(env)).length > 0, '被杀的会话留下了私有副本');

  // The next startup: leftovers swept, the ledger measured (nothing of the source was committed), merged again.
  windows.start('R', 'large', { ...env.state, manual: 'menu' });
  const again = await windows.waitFor('R', 'exit', { boot: 2, timeoutMs: 180_000 });
  assert.equal(again.code, 0, windows.stderr('R'));
  const r2 = windows.of('R', 2);
  assert.ok(first(r2, 'swept').removed >= 1, '启动时清理了残留');
  assert.deepEqual(first(r2, 'batch').deferred.map((item) => [item.candidateId, item.code]), [[fixture.alpha.id, RUNTIME_DATA_SET_MERGE_AWAITING_EXCLUSIVE]]);
  assert.ok(first(r2, 'engine-stage', (item) => item.stage === 'committing'));
  assert.deepEqual(r2.filter((event) => PROBLEMS.includes(event.event)), []);
  const actual = readAll(fixture.current);
  const after = await saveState(fixture, fixture.current);
  env.cleanup.push(() => after.remove());

  // The reference: the same source merged once without interruption into the target as it was before.
  await initial.restore();
  const reference = await runReferenceSession(env, {});
  assert.deepEqual(reference.results.map((result) => result.state), ['merged']);
  assert.deepEqual(actual, readAll(fixture.current), '与不中断的合并逐行相同');
  await after.restore();

  await reopenTwice(env, 3);
  await assertMergedAfterReload(t, env, 3, { sources: 1, conversations: CONVERSATIONS(LARGE_ROWS) + 1, finalized: true });
  await assertTargetMerged(env, [fixture.alpha], CONVERSATIONS(LARGE_ROWS) + 1);
});

test('大库会话端到端：三份大库合并到第二份时用户点“取消”：第一份保留，第二份整份撤回，第三份没有开始；三份来源文件逐字节不变，当前库与只合并第一份逐行相同；重载后如实说明，管理菜单只剩两份', { timeout: 300_000 }, async (t) => {
  const env = await environment(t, { beta: true });
  const { fixture, windows } = env;
  const gamma = await initializeScope(fixture.paths, 'gamma');
  const sources = { [fixture.alpha.id]: fixture.alpha, [fixture.beta.id]: fixture.beta, [gamma.id]: gamma };
  for (const [prefix, dataSet] of [['alpha', fixture.alpha], ['beta', fixture.beta], ['gamma', gamma]]) {
    await generateSyntheticSource(dataSet, { rows: LARGE_ROWS, prefix });
  }
  await holdStartupPrompt(fixture);
  const before = Object.fromEntries(await Promise.all(Object.entries(sources).map(async ([id, dataSet]) => [id, await sourceFiles(dataSet)])));
  const initial = await saveState(fixture, fixture.current);
  env.cleanup.push(() => initial.remove());

  windows.start('R', 'large', { ...env.state, manual: 'menu', cancelAt: { index: 1, merging: 3 } });
  const exited = await windows.waitFor('R', 'exit', { boot: 1, timeoutMs: 180_000 });
  assert.equal(exited.code, 0, windows.stderr('R'));
  const r1 = windows.of('R', 1);
  const order = first(r1, 'prepared').sources.map((source) => source.candidateId);
  assert.deepEqual([...order].sort(), Object.keys(sources).sort());
  assert.equal(first(r1, 'cancel-pressed').candidateId, order[1]);
  assert.ok(first(r1, 'engine-stage', (item) => item.index === 1 && item.stage === 'merging'), '第二份已开始写入');
  assert.equal(first(r1, 'engine-stage', (item) => item.index === 2), undefined, '第三份没有开始');
  assert.deepEqual(r1.filter((event) => PROBLEMS.includes(event.event)), []);

  assert.equal((await readLedgerRecord(fixture, order[0]))?.state, 'merged');
  assert.equal(await readLedgerRecord(fixture, order[1]), undefined, '撤回的一份没有记录');
  assert.equal(await readLedgerRecord(fixture, order[2]), undefined, '没开始的一份没有记录');
  assert.deepEqual([await ledgerEntries(fixture, 'commits'), await ledgerEntries(fixture, 'preparing')], [[], []]);
  for (const [id, dataSet] of Object.entries(sources)) assert.deepEqual(await sourceFiles(dataSet), before[id], `${id} 的文件不变`);
  assert.deepEqual(await leftovers(env), []);
  const actual = readAll(fixture.current);
  const after = await saveState(fixture, fixture.current);
  env.cleanup.push(() => after.remove());
  await initial.restore();
  const reference = await runReferenceSession(env, { candidateIds: [order[0]] });
  assert.deepEqual(reference.results.map((result) => [result.candidateId, result.state]), [[order[0], 'merged']]);
  assert.deepEqual(actual, readAll(fixture.current), '当前库与只合并第一份逐行相同');
  await after.restore();

  // Opened again: each outcome told once; the menu offers the remaining two with their measured size.
  windows.start('R', 'large', { ...env.state, lookAtMenu: true, settle: true });
  await windows.waitFor('R', 'menu-done', { boot: 2, timeoutMs: 120_000 });
  await windows.waitFor('R', 'settled', { boot: 2, timeoutMs: 60_000 });
  await windows.stop();
  const r2 = windows.of('R', 2);
  const notices = r2.filter((item) => item.event === 'notice').map((item) => item.message);
  assert.deepEqual(notices.sort(), [
    MERGED_TEXT(1, CONVERSATIONS(LARGE_ROWS), false),
    '有 2 份旧聊天记录暂时无法合并（合并时取消了，这一份已撤回，以后启动时会再合并；合并中途取消了，这一份还没有开始，以后启动时会再合并），以后启动时会自动重试。'
  ].sort());
  const waiting = first(r2, 'batch').deferred;
  assert.deepEqual(waiting.map((item) => item.candidateId).sort(), [order[1], order[2]].sort());
  const menu = first(r2, 'quick-pick', (item) => item.placeHolder === '历史与存储管理');
  const rows = waiting.reduce((sum, item) => sum + item.rows, 0);
  assert.ok(menu.labels.includes(`合并较大的旧聊天记录（2 份，${largeMergeWaitingText(rows)}）`), menu.labels.join('\n'));
  assert.equal(first(r2, 'settled').providerCalls, 0);
  assert.deepEqual(r2.filter((event) => [...PROBLEMS, 'warning'].includes(event.event)), []);
});

test('大库会话端到端（审查 #4）：手动准备时第二份还在准备就点“取消”：已准备好的第一份不协调、不合并，准备声明和这次做的当前库备份都释放；窗口照常可用', { timeout: 300_000 }, async (t) => {
  const env = await environment(t, { beta: true });
  const { fixture, windows } = env;
  await generateSyntheticSource(fixture.alpha, { rows: LARGE_ROWS, prefix: 'alpha' });
  await generateSyntheticSource(fixture.beta, { rows: LARGE_ROWS, prefix: 'beta' });
  await holdStartupPrompt(fixture);
  const backups = path.join(path.dirname(fixture.current.binding.paths.dataRootPath), RUNTIME_DATA_SET_MERGE_BACKUPS_DIRECTORY);
  const backupsBefore = await fs.readdir(backups).catch(() => []);
  const before = readAll(fixture.current);

  windows.start('R', 'large', { ...env.state, manual: 'menu', cancelPreparationAt: '^第 2/2 份' });
  await windows.waitFor('R', 'menu-done', { boot: 1, timeoutMs: 180_000 });
  // Nothing happens later either (no coordination is pending).
  await sleep(1_000);
  await windows.stop();
  const r1 = windows.of('R', 1);
  assert.ok(first(r1, 'preparation-cancel-pressed'));
  const prepared = first(r1, 'prepared');
  t.diagnostic(`the engine returned ${prepared?.sources.length} prepared source(s) after the cancel`);
  for (const event of ['locks-taken', 'frozen', 'runtime-closing', 'reload', 'engine-stage']) assert.equal(first(r1, event), undefined, event);
  assert.deepEqual(r1.filter((event) => [...PROBLEMS, 'notice'].includes(event.event) || (event.event === 'warning' && !event.modal)), []);
  assert.deepEqual([await ledgerEntries(fixture, 'preparing'), await ledgerEntries(fixture, 'commits')], [[], []], '准备声明已释放');
  for (const dataSet of [fixture.alpha, fixture.beta]) assert.equal(await readLedgerRecord(fixture, dataSet.id), undefined);
  assert.deepEqual(await fs.readdir(backups).catch(() => []), backupsBefore, '这次做的当前库备份已删除');
  assert.deepEqual(readAll(fixture.current), before);
  assert.deepEqual(await leftovers(env), []);
});

test('大库会话端到端（推迟）：倒计时里点“取消”——之前只做了只读估计（按批次缓存的审计，不再复制），什么都没准备：来源不收尾（中断的 Turn 与排队消息原样）、文件逐字节不变，当前库没有备份，账本没有记录与准备声明；下次启动批次与估计都按缓存、不复制，指纹不变，倒计时结束后才准备（这时才收尾，当前库只备份这一次），合并完成；之后两次打开 Provider 调用为 0', { timeout: 300_000 }, async (t) => {
  const env = await environment(t, { beta: true });
  const { fixture, windows } = env;
  await generateSyntheticSource(fixture.alpha, { rows: LARGE_ROWS, prefix: 'alpha' });
  await generateSyntheticSource(fixture.beta, { rows: MEDIUM_ROWS, prefix: 'beta' });
  await crashSource(env, fixture.alpha);
  const copies = watchPrivateCopies(env);
  const backups = path.join(path.dirname(fixture.current.binding.paths.dataRootPath), RUNTIME_DATA_SET_MERGE_BACKUPS_DIRECTORY);
  const backupsBefore = await fs.readdir(backups).catch(() => []);
  const filesBefore = { alpha: await sourceFiles(fixture.alpha), beta: await sourceFiles(fixture.beta) };

  // The first startup: the user postpones at the prompt; the window is closed later.
  windows.start('R', 'large', { ...env.state, cancelCountdown: true, closeWhenPostponed: true });
  const closed = await windows.waitFor('R', 'exit', { boot: 1, timeoutMs: 180_000 });
  assert.equal(closed.code, 0, windows.stderr('R'));
  const r1 = windows.of('R', 1);
  assert.deepEqual(r1.filter((event) => PROBLEMS.includes(event.event)), []);
  assertBatchLeftBoth(fixture, first(r1, 'batch'));
  const estimated = first(r1, 'estimated');
  assertEstimated(fixture, estimated, { cached: true });
  const countdown = first(r1, 'progress-report', (item) => item.message === countdownText(estimated, 1));
  assert.ok(countdown, r1.filter((item) => item.event === 'progress-report').map((item) => item.message).join('\n'));
  assert.ok(first(r1, 'notice', (item) => item.message === '已改到下次启动时再合并较大的旧聊天记录；也可以在“历史与存储管理”里手动开始。'));
  for (const event of ['preparing', 'prepared', 'locks-taken', 'frozen', 'runtime-closing', 'reload', 'engine-stage']) assert.equal(first(r1, event), undefined, event);
  // The batch copied and audited both sources once (before the prompt); the estimate copied nothing.
  const before = (at) => copies.names((item) => item.at < at);
  assert.ok(before(first(r1, 'batch').at).length >= 2, JSON.stringify(copies.all()));
  assert.deepEqual(copies.names((item) => item.at >= first(r1, 'estimating').at && item.at < countdown.at), [], '估计没有复制');
  // Postponed: the crashed Turn and the queued message still as they were, the sources byte for byte, no backup, nothing recorded.
  const crashed = inspect(fixture.alpha.binding.paths.databasePath);
  assert.deepEqual([crashed.activeTurns, crashed.leases, crashed.queuedIntents, crashed.busy], [1, 1, 1, true], '来源没有收尾');
  assert.deepEqual({ alpha: await sourceFiles(fixture.alpha), beta: await sourceFiles(fixture.beta) }, filesBefore, '来源逐字节不变');
  for (const dataSet of [fixture.alpha, fixture.beta]) {
    assert.equal(await fs.stat(path.join(path.dirname(dataSet.binding.paths.dataRootPath), RUNTIME_DATA_SET_MERGE_SOURCE_BACKUPS_DIRECTORY)).catch(() => undefined), undefined, '来源没有备份');
    assert.equal(await readLedgerRecord(fixture, dataSet.id), undefined);
  }
  assert.deepEqual(await fs.readdir(backups).catch(() => []), backupsBefore, '当前库没有备份');
  for (const section of ['preparing', 'commits', 'finalizations']) assert.deepEqual(await ledgerEntries(fixture, section), [], section);
  assert.ok((await ledgerEntries(fixture, 'audits')).length >= 2, '审计结果已缓存');
  assert.deepEqual(await leftovers(env), []);

  // The next startup: the batch and the estimate judge both from the cache (nothing copied before the prompt),
  // the same fingerprints (the same work); prepared only once the countdown ran out, then merged.
  const secondStart = Date.now();
  windows.start('R', 'large', env.state);
  const exited = await windows.waitFor('R', 'exit', { boot: 2, timeoutMs: 180_000 });
  assert.equal(exited.code, 0, windows.stderr('R'));
  const r2 = windows.of('R', 2);
  assert.deepEqual(r2.filter((event) => PROBLEMS.includes(event.event)), []);
  assertBatchLeftBoth(fixture, first(r2, 'batch'));
  const again = first(r2, 'estimated');
  assertEstimated(fixture, again, { cached: true });
  assert.deepEqual(again.sources.map((source) => [source.candidateId, source.fingerprint]), estimated.sources.map((source) => [source.candidateId, source.fingerprint]));
  const countdownAgain = first(r2, 'progress-report', (item) => item.message === countdownText(again, 1));
  assert.ok(countdownAgain);
  assert.deepEqual(copies.names((item) => item.at >= secondStart && item.at < countdownAgain.at), [], '批次与估计都按缓存，没有复制');
  assert.ok(first(r2, 'preparing').at >= countdownAgain.at, '倒计时结束后才准备');
  assertPrepared(fixture, first(r2, 'prepared'));
  assert.equal((await fs.readdir(backups)).length, backupsBefore.length + 1, '当前库只在准备时备份了一次');
  await reopenTwice(env, 3);
  await assertMergedAfterReload(t, env, 3, { sources: 2, conversations: CONVERSATIONS(LARGE_ROWS) + 1 + CONVERSATIONS(MEDIUM_ROWS), finalized: true });
  await assertTargetMerged(env, [fixture.alpha, fixture.beta], CONVERSATIONS(LARGE_ROWS) + 1 + CONVERSATIONS(MEDIUM_ROWS));
  copies.stop();
});

test('大库会话端到端（外来大库，自动流程）：用户请求合并的外来历史库超过内存上限，下次启动的批次把它留给大库会话；先只读估计（只经它的声明读，用可读名称）、倒计时写明两段时长，倒计时结束后才准备，会话合并、重载后说明；外来目录一字节不变、声明释放；之后两次打开 Provider 调用为 0', { timeout: 300_000 }, async (t) => {
  const env = await environment(t, {});
  const { fixture, windows } = env;
  const source = await requestedForeignRoot(env, LARGE_ROWS);
  const treeBefore = await treeSnapshot(source.container);

  windows.start('R', 'large', env.state);
  const exited = await windows.waitFor('R', 'exit', { boot: 1, timeoutMs: 180_000 });
  assert.equal(exited.code, 0, windows.stderr('R'));
  const r1 = windows.of('R', 1);
  assert.deepEqual(r1.filter((event) => PROBLEMS.includes(event.event)), []);
  assert.deepEqual(first(r1, 'batch').deferred.map((item) => [item.candidateId, item.code]), [[source.id, RUNTIME_DATA_SET_MERGE_AWAITING_EXCLUSIVE]]);
  // Estimated first (under its claim, outside the admission), named by its readable name; prepared only after the countdown.
  const estimating = first(r1, 'estimating');
  assert.deepEqual([estimating.candidateIds, estimating.requested], [[source.id], false]);
  const estimated = first(r1, 'estimated');
  assert.deepEqual(estimated.sources.map((item) => [item.candidateId, item.label]), [[source.id, source.label]]);
  assert.ok(estimated.sources[0].rows >= LARGE_ROWS, JSON.stringify(estimated.sources[0]));
  const countdown = first(r1, 'progress-report', (item) => item.message === countdownText(estimated, 1));
  assert.ok(countdown, r1.filter((item) => item.event === 'progress-report').map((item) => item.message).join('\n'));
  const preparing = first(r1, 'preparing');
  assert.ok(estimated.at < countdown.at && countdown.at <= preparing.at, JSON.stringify([estimated.at, countdown.at, preparing.at]));
  assert.deepEqual(first(r1, 'prepared').sources.map((item) => [item.candidateId, item.label, item.fingerprint]),
    [[source.id, source.label, estimated.sources[0].fingerprint]], '外来来源不收尾：指纹与估计相同');
  assert.ok(first(r1, 'engine-stage', (item) => item.stage === 'committing'));
  assert.equal(first(r1, 'reload') !== undefined, true);
  // Kept for the reload: named by its readable name.
  const kept = JSON.parse(await fs.readFile(env.state.windowStateFile, 'utf8'));
  assert.ok(JSON.stringify(kept).includes(source.label), JSON.stringify(kept));

  windows.start('R', 'large', { ...env.state, settle: true, reloadWhenSettled: true });
  await windows.waitFor('R', 'exit', { boot: 2, timeoutMs: 120_000 });
  windows.start('R', 'large', { ...env.state, settle: true, closeWhenSettled: true });
  await windows.waitFor('R', 'exit', { boot: 3, timeoutMs: 120_000 });
  const told = windows.of('R', 2).filter((item) => item.event === 'notice' && /^已把 1 份较大的旧聊天记录合并到当前历史库/.test(item.message));
  assert.equal(told.length, 1, JSON.stringify(windows.of('R', 2).filter((item) => item.event === 'notice')));
  assert.ok(told[0].message.startsWith(`已把 1 份较大的旧聊天记录合并到当前历史库（新增 ${CONVERSATIONS(LARGE_ROWS)} 个对话）`), told[0].message);
  for (const boot of [2, 3]) {
    assert.deepEqual(pick(first(windows.of('R', boot), 'settled'), 'providerCalls', 'resumedTurnIds', 'queuedConversationIds'),
      { providerCalls: 0, resumedTurnIds: [], queuedConversationIds: [] });
  }
  assert.deepEqual(windows.of('R', 3).filter((item) => item.event === 'notice'), [], '结果只提示一次');
  assert.equal((await readLedgerRecord(fixture, source.id))?.state, 'merged');
  assert.equal(inspect(fixture.current.binding.paths.databasePath).conversations, CONVERSATIONS(LARGE_ROWS));
  assert.deepEqual(await treeSnapshot(source.container), treeBefore, '外来目录一字节不变');
  assert.deepEqual(await fs.readdir(path.join(resolveVscodeRuntimeMergeLedgerRoot(fixture.paths), 'foreign-claims')).catch(() => []), [], '声明已释放');
  assert.deepEqual([await ledgerEntries(fixture, 'commits'), await ledgerEntries(fixture, 'preparing')], [[], []]);
  assert.deepEqual(await leftovers(env), []);
});

// ---------------------------------------------------------------------------------------------
// shared checks
// ---------------------------------------------------------------------------------------------

/** Both sources (the large one and the medium one) left to the session by the startup batch, with their sizes. */
function assertBatchLeftBoth(fixture, batch) {
  assert.deepEqual(batch.merged, []);
  assert.deepEqual(batch.deferred.map((item) => [item.candidateId, item.code]).sort(),
    [[fixture.alpha.id, RUNTIME_DATA_SET_MERGE_AWAITING_EXCLUSIVE], [fixture.beta.id, RUNTIME_DATA_SET_MERGE_AWAITING_EXCLUSIVE]].sort());
  assert.ok(batch.deferred.every((item) => item.rows > 4_000), JSON.stringify(batch.deferred));
}

/** The estimate of both sources (the large one and the medium one): named, cached or not, both durations in their ranges. */
function assertEstimated(fixture, estimated, { cached }) {
  assert.deepEqual(estimated.sources.map((source) => source.candidateId).sort(), [fixture.alpha.id, fixture.beta.id].sort());
  assert.deepEqual(estimated.sources.map((source) => source.label), ['旧工作区历史', '旧工作区历史']);
  assert.deepEqual(estimated.sources.map((source) => source.cached), [cached, cached], JSON.stringify(estimated.sources));
  for (const part of [estimated.preparing, estimated.duration, ...estimated.sources.flatMap((source) => [source.preparing, source.duration])]) {
    assert.ok(part.expectedMs > 0 && part.minMs <= part.expectedMs && part.expectedMs <= part.maxMs, JSON.stringify(part));
  }
  assert.equal(estimated.stopped, false);
  assert.deepEqual(estimated.settled, { merged: [], deferred: [], blocked: [], failures: [] });
}

/** The startup prompt as the estimate makes it: its size, then the background preparation and the pause of every window. */
function countdownText(estimated, seconds) {
  return largeMergeCountdownText({
    seconds, sources: estimated.sources.length, rows: estimated.sources.reduce((sum, source) => sum + source.rows, 0),
    preparing: estimated.preparing, duration: estimated.duration
  });
}

function assertPrepared(fixture, prepared) {
  assert.deepEqual(prepared.sources.map((source) => source.candidateId).sort(), [fixture.alpha.id, fixture.beta.id].sort());
  // Labelled as the candidate list names them (no project names were read in this window).
  assert.deepEqual(prepared.sources.map((source) => source.label), ['旧工作区历史', '旧工作区历史']);
  assert.ok(prepared.sources.every((source) => source.duration.minMs <= source.duration.expectedMs && source.duration.expectedMs <= source.duration.maxMs));
}

function assertPreparationReports(reports) {
  const messages = reports.map((item) => item.message);
  assert.ok(messages.some((message) => /^第 [12]\/2 份：正在收尾中断的任务$/.test(message)), messages.join('\n'));
  assert.ok(messages.some((message) => /^第 [12]\/2 份：正在逐条比较/.test(message)), messages.join('\n'));
}

/**
 * After `before`: the locks, this window frozen before go, its Runtime closed, then the engine, the
 * reload last; the other window reloaded before this Runtime closed and opened once the locks went.
 */
function assertSessionOrder(windows, r1, before) {
  const at = (event, match) => first(r1, event, match)?.at;
  const order = [...before, at('locks-taken'), at('frozen'), at('runtime-closed'), at('engine-stage'), at('locks-released'), at('reload')];
  assert.ok(order.every((value, index) => value !== undefined && (index === 0 || order[index - 1] <= value)), JSON.stringify(order));
  assert.ok(first(windows.of('W', 1), 'reload').at <= at('runtime-closed'), '其它窗口先重载');
  assert.ok(first(windows.of('W', 2), 'opened').at >= at('locks-released'));
  const stages = r1.filter((item) => item.event === 'engine-stage').map((item) => item.stage);
  assert.ok(stages.includes('merging') && stages.includes('committing'), stages.join(','));
  const reports = r1.filter((item) => item.event === 'progress-report' && /^正在合并较大的旧聊天记录 [12]\/2（已处理 .+ \/ .+条，约还需.+）$/.test(item.message));
  assert.ok(reports.length >= 1, '会话进度');
  for (let i = 1; i < reports.length; i += 1) assert.ok(reports[i].at - reports[i - 1].at >= 450, '进度最多每 0.5 秒一次');
  // The window opening meanwhile saw the session's stage in steps of 5 %.
  const statuses = windows.of('W', 2).filter((item) => item.event === 'opening-status').map((item) => item.description);
  assert.ok(statuses.every((text) => !/已完成 \d*[1-46-9]%/.test(text)), statuses.join('\n'));
}

/** The requesting window opened twice more: the result told once (boot `boot`), no Provider call either time. */
async function assertMergedAfterReload(t, env, boot, { sources, conversations, finalized }) {
  const { windows } = env;
  const opened = windows.of('R', boot);
  const merged = opened.filter((item) => item.event === 'notice' && /^已把/.test(item.message));
  assert.deepEqual(merged.map((item) => [item.message, item.items]), [[MERGED_TEXT(sources, conversations, finalized), ['查看详情']]]);
  for (const events of [opened, windows.of('R', boot + 1)]) {
    assert.deepEqual(pick(first(events, 'settled'), 'providerCalls', 'resumedTurnIds', 'queuedConversationIds'),
      { providerCalls: 0, resumedTurnIds: [], queuedConversationIds: [] });
    assert.deepEqual(events.filter((item) => [...PROBLEMS, 'warning'].includes(item.event)), []);
  }
  assert.deepEqual(windows.of('R', boot + 1).filter((item) => item.event === 'notice'), [], '结果只提示一次');
  t.diagnostic(`opening statuses of the other window: ${JSON.stringify(windows.of('W', 2).filter((item) => item.event === 'opening-status').map((item) => item.description))}`);
}

async function assertTargetMerged(env, dataSets, conversations) {
  const { fixture } = env;
  const target = inspect(fixture.current.binding.paths.databasePath);
  assert.deepEqual([target.conversations, target.activeTurns, target.leases, target.queuedIntents, target.nonTerminalRequests, target.busy],
    [conversations, 0, 0, 0, 0, false]);
  assert.ok(target.reasons.includes(MERGE_FINALIZATION_REASON));
  for (const dataSet of dataSets) assert.equal((await readLedgerRecord(fixture, dataSet.id))?.state, 'merged');
  assert.deepEqual([await ledgerEntries(fixture, 'commits'), await ledgerEntries(fixture, 'preparing')], [[], []]);
  assert.deepEqual(await leftovers(env), [], '没有残留的私有副本');
}

// ---------------------------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------------------------

/**
 * The configuration root (current, alpha, beta?), the settings of the full Runtime, a temporary
 * directory of the windows (their private copies) and the windows; cleaned up in reverse order
 * (windows stopped before their directories go).
 */
async function environment(t, options) {
  const cleanup = [];
  t.after(async () => { for (const step of cleanup.reverse()) await step().catch(() => undefined); });
  const fixture = await createConfigurationRoot(options);
  cleanup.push(async () => {
    await fs.rm(fixture.root, { recursive: true, force: true });
    // The configuration admission lives next to the root; a killed window leaves a dead generation of it there.
    const parent = path.dirname(fixture.root);
    for (const name of await fs.readdir(parent)) {
      if (name.startsWith(`${path.basename(fixture.root)}.runtime-`)) await fs.rm(path.join(parent, name), { recursive: true, force: true });
    }
  });
  const settingsRoot = `${fixture.root}-settings`;
  const tmp = `${fixture.root}-tmp`;
  const stateRoot = `${fixture.root}-state`;
  for (const directory of [settingsRoot, tmp, stateRoot]) {
    await fs.mkdir(directory, { recursive: true });
    cleanup.push(() => fs.rm(directory, { recursive: true, force: true }));
  }
  const windows = createWindows(fixture.root, settingsRoot, tmp);
  cleanup.push(() => windows.stop());
  return {
    fixture, settingsRoot, tmp, windows, cleanup,
    state: { windowStateFile: path.join(stateRoot, 'R-workspace-state.json'), globalStateFile: path.join(stateRoot, 'global-state.json') }
  };
}

/** The requesting window opens the current library twice more (boots `boot` and `boot + 1`). */
async function reopenTwice(env, boot) {
  const { windows } = env;
  windows.start('R', 'large', { ...env.state, settle: true, reloadWhenSettled: true });
  await windows.waitFor('R', 'exit', { boot, timeoutMs: 120_000 });
  windows.start('R', 'large', { ...env.state, settle: true, closeWhenSettled: true });
  await windows.waitFor('R', 'exit', { boot: boot + 1, timeoutMs: 120_000 });
}

/** Another window of this configuration root (this process, alive) holds the startup prompt: the windows here are not asked. */
async function holdStartupPrompt(fixture) {
  assert.equal(await claimLargeMergePrompt(fixture.paths, { sessionId: 'another-window-session', hostBootId: 'another-window' }), true);
}

function createWindows(root, settingsRoot, tmp) {
  const state = { stopped: false, children: new Map(), events: [], boots: {}, stderr: {} };
  const listeners = new Set();
  const record = (event) => {
    state.events.push(event);
    for (const listener of [...listeners]) listener();
  };
  function start(name, kind, behavior = {}, { restartOnReload = false } = {}) {
    const boot = state.boots[name] = (state.boots[name] ?? 0) + 1;
    const env = { ...process.env, LIMCODE_TEST_EXTENSION_ROOT: compiled, TMPDIR: tmp };
    delete env.NODE_TEST_CONTEXT;
    if (kind === 'large') env.LIMCODE_LARGE_MERGE_WINDOW = JSON.stringify({ root, settingsRoot, name, boot, behavior });
    else env.LIMCODE_EXCLUSIVE_MAINTENANCE_WINDOW = JSON.stringify({ root, name, boot, behavior });
    const child = spawn(process.execPath, [SCRIPTS[kind]], { cwd: process.cwd(), env, stdio: ['ignore', 'pipe', 'pipe'] });
    state.children.set(name, child);
    let buffer = '';
    child.stderr.setEncoding('utf8');
    child.stderr.on('data', (chunk) => { state.stderr[name] = `${state.stderr[name] ?? ''}${chunk}`.slice(-20_000); });
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (chunk) => {
      buffer += chunk;
      let newline;
      while ((newline = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, newline);
        buffer = buffer.slice(newline + 1);
        if (line.startsWith('{')) record(JSON.parse(line));
      }
    });
    child.once('exit', (code, signal) => {
      if (state.children.get(name) === child) state.children.delete(name);
      const reloaded = state.events.some((event) => event.name === name && event.boot === boot && event.event === 'reload');
      record({ name, boot, event: 'exit', code, signal, at: Date.now() });
      if (restartOnReload && reloaded && !state.stopped) start(name, kind, behavior, { restartOnReload });
    });
  }
  const exitOf = (child) => new Promise((resolve) => {
    if (child.exitCode !== null || child.signalCode !== null) return resolve();
    child.once('exit', resolve);
    child.kill('SIGKILL');
  });
  return {
    start,
    events: () => state.events,
    of: (name, boot) => state.events.filter((event) => event.name === name && event.boot === boot),
    stderr: (name) => state.stderr[name] ?? '',
    /** The first event of this window (of boot `boot`, default any) that matches, also one still to come. */
    waitFor: (name, eventName, { boot, timeoutMs = 60_000, match = () => true } = {}) => new Promise((resolve, reject) => {
      const check = () => {
        const found = state.events.find((event) => event.name === name && event.event === eventName
          && (boot === undefined || event.boot === boot) && match(event));
        if (!found) return;
        listeners.delete(check);
        clearTimeout(timer);
        resolve(found);
      };
      const timer = setTimeout(() => {
        listeners.delete(check);
        reject(new Error(`${name} did not report ${eventName}: ${JSON.stringify(state.events.filter((event) => event.name === name).slice(-30))}\n${state.stderr[name] ?? ''}`));
      }, timeoutMs);
      listeners.add(check);
      check();
    }),
    async stop() {
      state.stopped = true;
      await Promise.all([...state.children.values()].map(exitOf));
    }
  };
}

/** An old window on this source killed in the middle of a Turn (a second message queued behind it). */
async function crashSource(env, dataSet) {
  const readyFile = `${env.fixture.root}-crash-ready.json`;
  env.cleanup.push(() => fs.rm(readyFile, { force: true }));
  const child = execFile(process.execPath, [path.join(HERE, 'runtime-dataset-merge-crash-child.mjs'), dataSet.scopeRoot, env.settingsRoot, readyFile],
    { env: { ...process.env, LIMCODE_TEST_EXTENSION_ROOT: compiled } });
  let stderr = '';
  child.stderr.on('data', (chunk) => { stderr += chunk; });
  const exited = new Promise((resolve) => child.on('exit', (code, signal) => resolve({ code, signal })));
  const deadline = Date.now() + 90_000;
  while (!(await fs.stat(readyFile).then(() => true, () => false))) {
    if (Date.now() > deadline || child.exitCode !== null) assert.fail(`crash child never became ready: ${stderr}`);
    await sleep(50);
  }
  child.kill('SIGKILL');
  assert.equal((await exited).signal, 'SIGKILL');
  const crashed = inspect(dataSet.binding.paths.databasePath);
  assert.deepEqual([crashed.activeTurns, crashed.leases, crashed.queuedIntents, crashed.busy], [1, 1, 1, true], '来源里有中断的 Turn 和排队消息');
}

/** A1's session child: the pending sources prepared and merged once, without interruption. */
function runReferenceSession(env, input) {
  return new Promise((resolve, reject) => {
    execFile(process.execPath, [path.join(HERE, 'runtime-dataset-merge-streamed-child.mjs'), env.fixture.root, JSON.stringify(input)], {
      env: { ...process.env, LIMCODE_TEST_EXTENSION_ROOT: compiled, TMPDIR: env.tmp }, maxBuffer: 16 * 1024 * 1024
    }, (error, stdout, stderr) => (error ? reject(new Error(`${error.message}\n${stderr}`)) : resolve(JSON.parse(stdout))));
  });
}

/**
 * Private copies of a source's SQLite files the windows take (runtimeStorageInspection's
 * `limcode-runtime-history-<pid>-…` directories in their temporary directory), each with when it
 * appeared (seen by this process; a copy's lifetime is far longer than the delay).
 */
function watchPrivateCopies(env) {
  const seen = new Map();
  const watcher = fsSync.watch(env.tmp, (_event, name) => {
    if (typeof name === 'string' && name.startsWith('limcode-runtime-history-') && !seen.has(name)) seen.set(name, Date.now());
  });
  env.cleanup.push(async () => watcher.close());
  const all = () => [...seen].map(([name, at]) => ({ name, at }));
  return { all, names: (match) => all().filter(match).map((item) => item.name), stop: () => watcher.close() };
}

/**
 * A LimCode data directory made elsewhere with `rows` rows of history, copied beside the current
 * configuration root under the name a data-root relocation gives a copied directory; the user asked
 * to merge it (the request recorded as the foreign history list records it).
 */
async function requestedForeignRoot(env, rows) {
  const { fixture } = env;
  const container = `${fixture.root}.limcode-copied-2026-09-28T01-02-03-004Z-00000001`;
  env.cleanup.push(() => fs.rm(container, { recursive: true, force: true }));
  const elsewhere = await createConfigurationRoot({});
  try {
    await generateSyntheticSource(elsewhere.current, { rows, prefix: 'foreign' });
    await fs.cp(elsewhere.root, container, { recursive: true });
  } finally {
    await fs.rm(elsewhere.root, { recursive: true, force: true });
  }
  const entries = await foreign.discoverForeignRuntimeHistory({ configurationRootPath: fixture.root });
  const entry = entries.find((item) => item.location.containerPath === container && item.scope === 'default' && !item.archiveName);
  assert.ok(entry, JSON.stringify(entries.map((item) => [item.location.containerPath, item.scope])));
  const root = await foreign.locateForeignRuntimeRoot(fixture.root, entry.location);
  const label = `外来历史库（${entry.name}）`;
  await foreignMerge.requestForeignRuntimeHistoryMerge(fixture.paths, {
    id: entry.id, location: entry.location, label,
    expectedDataSetId: root.recorded.dataSetId, expectedRootInstanceId: root.recorded.rootInstanceId
  });
  return { id: entry.id, label, container };
}

/** Private copies and other temporary files of the windows' sessions. */
async function leftovers(env) {
  return (await fs.readdir(env.tmp)).filter((entry) => entry.startsWith('limcode-'));
}

/** The source's SQLite files and CAS objects, byte for byte. */
async function sourceFiles(dataSet) {
  const database = dataSet.binding.paths.databasePath;
  const files = {};
  for (const suffix of ['', '-wal']) files[suffix || 'db'] = await fs.readFile(`${database}${suffix}`).then(sha256, () => 'absent');
  return { files, cas: await treeSnapshot(dataSet.binding.paths.casRootPath) };
}

function inspect(databasePath) {
  const database = new Database(databasePath, { readonly: true });
  try {
    database.defaultSafeIntegers(false);
    const count = (sql) => database.prepare(sql).pluck().get();
    return {
      conversations: count('SELECT COUNT(*) FROM conversation'),
      activeTurns: count("SELECT COUNT(*) FROM turn WHERE status = 'active'"),
      leases: count('SELECT COUNT(*) FROM execution_lease'),
      queuedIntents: count("SELECT COUNT(*) FROM turn_intent WHERE state = 'queued'"),
      nonTerminalRequests: count("SELECT COUNT(*) FROM model_request WHERE status <> 'terminal'"),
      reasons: database.prepare('SELECT DISTINCT reason FROM turn_termination').pluck().all(),
      busy: createConversationRuntimeWorkProbe(database)('crash_conversation')
    };
  } finally { database.close(); }
}

function first(events, event, match = () => true) {
  return events.find((item) => item.event === event && match(item));
}

function pick(value, ...keys) {
  return value ? Object.fromEntries(keys.map((key) => [key, value[key]])) : value;
}
