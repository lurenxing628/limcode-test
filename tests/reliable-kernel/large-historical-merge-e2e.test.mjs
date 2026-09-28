// End to end: the large merge session (大库会话) with the real engine. Every window is its own process:
// large-historical-merge-window.mjs opens the full production Runtime composition (only the model
// Provider is synthetic, and every call to it is recorded) and runs the real startup flow and the
// manual entry of runtimeDataSetManagement.ts / largeHistoricalMerge.ts; runtime-exclusive-maintenance-
// window.mjs is another window that only takes part. The sources are written through Repositories
// (A1's fixture); one of them was left by an old window killed in the middle of a Turn.
import assert from 'node:assert/strict';
import { execFile, spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import {
  compiled, createConfigurationRoot, Database, generateSyntheticSource, initializeScope, kernelFile, ledgerEntries, readAll,
  readLedgerRecord, saveState, sha256, treeSnapshot
} from './fixtures/runtime-merge-fixture.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const { MERGE_FINALIZATION_REASON, RUNTIME_DATA_SET_MERGE_AWAITING_EXCLUSIVE, RUNTIME_DATA_SET_MERGE_BACKUPS_DIRECTORY } = kernelFile('runtimeDataSetMerge.js');
const { claimLargeMergePrompt, largeMergeWaitingText, formatLargeMergeRowsWithUnit } = kernelFile('runtimeLargeMergeSession.js');
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

test('大库会话端到端（自动流程，真实引擎，只假 Provider）：带中断 Turn 的大库与一份中等来源在启动批次里一起等待；在线准备（收尾中断任务）、倒计时、与另一个窗口协调（不可否决的倒计时）、关闭运行时、会话、重载、结果提示依次发生；之后两次打开当前库 Provider 调用都为 0', { timeout: 300_000 }, async (t) => {
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
  // Prepared online, in the status bar, while the window stayed usable: the crashed Turn closed, compared, the target backed up.
  const prepared = first(r1, 'prepared');
  assertPrepared(fixture, prepared);
  assert.ok(first(r1, 'progress', (item) => item.title === '正在准备合并较大的旧聊天记录' && item.location === 10), '准备在状态栏进行');
  assertPreparationReports(r1.filter((item) => item.event === 'progress-report' && item.title === '正在准备合并较大的旧聊天记录'));
  // The countdown, then the coordination: the other window counted down without a cancel and reloaded once.
  const countdown = first(r1, 'progress-report', (item) => /^将在 1 秒后合并 2 份较大的旧聊天记录（约 [\d.]+ 万条，预计 .+）。点“取消”改到下次启动。$/.test(item.message));
  assert.ok(countdown, r1.filter((item) => item.event === 'progress-report').map((item) => item.message).join('\n'));
  assert.equal(first(windows.of('W', 1), 'progress', (item) => item.countdown)?.cancellable, false, '其它窗口不可否决');
  assert.equal(windows.events().filter((event) => event.name === 'W' && event.event === 'reload').length, 1, '只协调了一次（中等来源没有单独协调）');
  assertSessionOrder(windows, r1, [prepared.at, countdown.at]);
  await assertMergedAfterReload(t, env, 2, { sources: 2, conversations: CONVERSATIONS(LARGE_ROWS) + 1 + CONVERSATIONS(MEDIUM_ROWS), finalized: true });
  await assertTargetMerged(env, [fixture.alpha, fixture.beta], CONVERSATIONS(LARGE_ROWS) + 1 + CONVERSATIONS(MEDIUM_ROWS));
});

test('大库会话端到端（手动流程）：历史与存储管理里按批次测得的规模开始，先确认再在后台准备（可取消的通知），其它窗口只收到提示；会话、重载、结果提示；之后两次打开 Provider 调用都为 0', { timeout: 300_000 }, async (t) => {
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
  // The startup prompt is another window's: nothing is prepared or counted down here before the user asks.
  assert.equal(r1.filter((item) => item.event === 'prepared').length, 1);
  assert.equal(first(r1, 'progress-report', (item) => /^将在/.test(item.message)), undefined);
  // The menu and the confirmation give the size the batch measured, and no made-up duration.
  const rows = batch.deferred.reduce((sum, item) => sum + item.rows, 0);
  const menu = first(r1, 'quick-pick', (item) => item.placeHolder === '历史与存储管理');
  assert.ok(menu.labels.includes(`合并较大的旧聊天记录（2 份，${largeMergeWaitingText(rows)}）`), menu.labels.join('\n'));
  const confirm = first(r1, 'warning', (item) => item.modal);
  assert.equal(confirm.message, `合并较大的旧聊天记录（2 份，约 ${formatLargeMergeRowsWithUnit(rows)}记录）？`);
  assert.ok(confirm.detail.startsWith(`约 ${formatLargeMergeRowsWithUnit(rows)}记录；预计要多久，准备好之后在进度里给出。`), confirm.detail);
  const prepared = first(r1, 'prepared');
  assertPrepared(fixture, prepared);
  assert.ok(first(r1, 'progress', (item) => item.title === '正在准备合并较大的旧聊天记录（窗口照常可用）' && item.cancellable && item.location === 15));
  assertPreparationReports(r1.filter((item) => item.event === 'progress-report' && item.title === '正在准备合并较大的旧聊天记录（窗口照常可用）'));
  // The user confirmed here: the other window was only told, without a countdown.
  const w1 = windows.of('W', 1);
  assert.ok(first(w1, 'notice', (item) => item.message === '为合并较大的旧聊天记录，本窗口将重载；未发送的输入会保留。'));
  assert.equal(first(w1, 'progress', (item) => item.countdown), undefined);
  assert.equal(windows.events().filter((event) => event.name === 'W' && event.event === 'reload').length, 1);
  assertSessionOrder(windows, r1, [menu.at, confirm.at, prepared.at]);
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
