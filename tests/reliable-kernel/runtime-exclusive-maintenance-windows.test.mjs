import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import fsSync from 'node:fs';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import vm from 'node:vm';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

/**
 * Multi-window exclusive maintenance end to end. Part 1 loads the real VS Code layer
 * (vscode/runtimeExclusiveMaintenance.ts) in this process; part 2 runs every window as its own process
 * like a real startup (runtime-exclusive-maintenance-window.mjs: open first under the admission, then
 * the participant, then the background merge with the call site's parameters and window id). The
 * reviewed failures (windows reloading each other forever after a failed operation, waiting inside
 * the locks so no window could open, the requester reloading itself) are asserted not to happen.
 */
const require = createRequire(import.meta.url);
const compiled = process.env.LIMCODE_TEST_EXTENSION_ROOT
  ? path.resolve(process.env.LIMCODE_TEST_EXTENSION_ROOT) : path.resolve('dist/extension');
const kernelFile = (file) => require(path.join(compiled, 'backend/reliableKernel', file));
const kernel = kernelFile('index.js');
const exclusive = kernelFile('runtimeExclusiveMaintenance.js');
const { readExclusiveMaintenanceRequests, requestExclusiveRuntimeMaintenance, runtimeExclusiveMaintenanceDirectory } = exclusive;
const { withRuntimeDataRootAdmission, withRuntimeMaintenance } = kernelFile('runtimeHostControl.js');
const { ownProcessStartIdentity } = kernelFile('runtimeClaimPrimitives.js');
const { RootAuthority } = kernelFile('rootAuthority.js');
const { projectFolderAssignmentSteps } = kernelFile('conversationProject.js');
const { requestRuntimeDataSetMerge } = kernelFile('runtimeDataSetMerge.js');
const {
  resolveVscodeRuntimeDataRoot, resolveVscodeWorkspaceRuntimeScope, resolveVscodeWorkspaceRuntimeScopeRoot,
  selectVscodeRuntimeDataSet
} = kernelFile('vscodeRootAuthority.js');

const WINDOW = path.join(path.dirname(fileURLToPath(import.meta.url)), 'runtime-exclusive-maintenance-window.mjs');
const NOW = '2026-09-26T00:00:00.000Z';
const STARTED = '2026-01-01T00:00:00.000Z';
const MESSAGE_TYPE = 'application/vnd.limcode.message+json';
const PROJECT = { uri: 'file:///workspace/shared', name: 'shared' };
const MERGE = { operation: 'historical-merge', operationKey: 'workspace:alpha', message: '为合并旧聊天记录', ignoreBackoff: false };
// Small enough that the seeded source needs the exclusive fallback.
const LIMITS = { maxRows: 5, maxBytes: 1024 * 1024 * 1024 };
let nextFakeProcessId = 4_000_000;

// ---------------------------------------------------------------------------------------------
// Part 1: the VS Code layer in this process.
// ---------------------------------------------------------------------------------------------

test('窗口按原因回答忙：有任务是 work，用户正在使用是 focus；提示文案分开', async (t) => {
  const { binding, paths } = await createRoot(t);
  const working = await layerWindow(t, binding, 'working-window', { work: true });
  const focused = await layerWindow(t, binding, 'focused-window', { focused: true });
  const outcome = await withRuntimeMaintenance(paths, () => requestExclusiveRuntimeMaintenance(paths, {
    ...MERGE, pollMs: 10
  }, async () => assert.fail('must not run')));
  assert.equal(outcome.state, 'busy');
  // Abandoned at the first busy answer(s) seen, each kind named apart.
  assert.match(outcome.reason, /^(1 个其它窗口有任务正在进行|1 个其它窗口正在使用|1 个其它窗口有任务正在进行，1 个其它窗口正在使用)，暂不打扰。$/);
  assert.deepEqual([working.countdowns(), focused.countdowns()], [[], []]);

  // Waiting (outside the locks): each is told once, in advance, with the right reason.
  setTimeout(() => { working.work = false; focused.focused = false; }, 200);
  const layer = loadVscodeLayer(vscodeMock({ titles: [], notices: [] }, () => {}));
  const waited = await layer.runWithExclusiveMaintenance(paths, {
    ...MERGE, operation: 'data-root-migration', message: '为迁移数据目录', ignoreBackoff: true, whenBusy: 'wait',
    participantConfirmation: 'notice', waitingTitle: '正在等待其它窗口空闲后迁移数据目录', pollMs: 10, isCurrent: () => true,
    withLocks: (body) => withRuntimeMaintenance(paths, body)
  }, async () => 'migrated');
  assert.deepEqual(waited, { state: 'completed', result: 'migrated', coordinated: true });
  assert.deepEqual(working.notices.filter((notice) => /自动重载/.test(notice)),
    ['为迁移数据目录：本窗口的任务结束后会自动重载，未发送的输入会保留。']);
  assert.deepEqual(focused.notices.filter((notice) => /自动重载/.test(notice)),
    ['为迁移数据目录：你正在使用本窗口，切换到其它窗口后本窗口会自动重载，未发送的输入会保留。']);
});

test('倒计时但不可否决：用户已确认的操作里，其它窗口的倒计时没有取消按钮，点了也照样重载', async (t) => {
  for (const confirmation of ['countdown', 'final-countdown']) {
    const { binding, paths } = await createRoot(t);
    const window = await layerWindow(t, binding, `${confirmation}-window`, { cancel: true });
    const outcome = await withRuntimeMaintenance(paths, () => requestExclusiveRuntimeMaintenance(paths, {
      ...MERGE, participantConfirmation: confirmation, pollMs: 10
    }, async () => 'done'));
    if (confirmation === 'countdown') {
      assert.equal(outcome.state, 'declined', 'an ordinary countdown can be cancelled');
      assert.equal(window.reloads, 0);
      assert.deepEqual(window.cancellable, [true]);
    } else {
      assert.equal(outcome.state, 'completed');
      assert.equal(window.reloads, 1);
      assert.deepEqual(window.cancellable, [false]);
    }
  }
});

test('盲审 #6：倒计时期间请求被撤回（另一个窗口的用户选择保留）：倒计时立即关闭并说明本次不重载', async (t) => {
  const { binding, paths } = await createRoot(t);
  const counting = await layerWindow(t, binding, 'counting-window', { countdownSeconds: 5 });
  await layerWindow(t, binding, 'keeping-window', { cancel: true });
  const started = Date.now();
  const outcome = await withRuntimeMaintenance(paths, () => requestExclusiveRuntimeMaintenance(paths, {
    ...MERGE, pollMs: 10
  }, async () => assert.fail('must not run')));
  assert.equal(outcome.state, 'declined');
  for (let polls = 0; polls < 150 && !counting.notices.some((notice) => /本窗口不重载/.test(notice)); polls += 1) await delay(20);
  assert.ok(Date.now() - started < 3_000, `the countdown closed early (${Date.now() - started} ms)`);
  assert.deepEqual(counting.notices.filter((notice) => /本窗口不重载/.test(notice)), ['其它窗口的合并旧聊天记录这次没有进行，本窗口不重载。']);
  assert.deepEqual(counting.countdowns(), ['为合并旧聊天记录，本窗口即将重载']);
  assert.equal(counting.reloads, 0);
});

test('盲审 #6：倒计时期间请求进入新一轮（发起方回锁外后重新协调）时倒计时悄悄关闭，不说“不重载”；请求随后撤回也不补这句', async (t) => {
  const { binding, paths } = await createRoot(t);
  const notices = [];
  const titles = [];
  let reloads = 0;
  const layer = loadVscodeLayer(vscodeMock({ titles, notices }, () => { reloads += 1; }));
  const liveness = await publishHost(binding, 'window-rounds');
  const participant = layer.startExclusiveMaintenanceParticipant({
    exclusiveMaintenanceTarget: () => ({ paths, hostBootId: 'window-rounds' }), hasOwnedExecution: async () => false
  }, { countdownSeconds: 5, pollMs: 60 * 60_000, processId: (nextFakeProcessId += 1) });
  t.after(async () => { await participant.dispose(); await fs.rm(liveness, { force: true }); });
  const request = { requestId: 'round-request', createdAt: new Date().toISOString(), whenBusy: 'wait' };
  await writeRequest(paths, { ...request, phase: 'prepare' });
  await participant.checkNow();
  await writeRequest(paths, { ...request, phase: 'confirm' });
  const started = Date.now();
  const counting = participant.checkNow();
  await delay(600);
  await writeRequest(paths, { ...request, round: 2, phase: 'prepare' });
  await counting;
  assert.ok(Date.now() - started < 3_000, `closed early (${Date.now() - started} ms)`);
  assert.equal(titles.filter((title) => /即将重载/.test(title)).length, 1);
  await fs.rm(path.join(runtimeExclusiveMaintenanceDirectory(paths), 'requests', 'round-request.json'), { force: true });
  await participant.checkNow();
  assert.deepEqual(notices.filter((notice) => /不重载/.test(notice)), []);
  assert.equal(reloads, 0);
});

test('发起方自身忙碌只看任务不看焦点（requesterWorkBusy）', async () => {
  const layer = loadVscodeLayer(vscodeMock({ titles: [], notices: [], focused: true }, () => {}));
  assert.equal(await layer.requesterWorkBusy({ hasOwnedExecution: async () => false })(), undefined);
  // Spread: the layer runs in its own vm realm.
  assert.deepEqual({ ...await layer.requesterWorkBusy({ hasOwnedExecution: async () => true })() },
    { kind: 'work', reason: '本窗口有任务正在进行' });
});

test('打开运行时等待时说明原因：外壳只写持有方在做什么和阶段（不带秒数），通知带耗时；久等按当前持有者计时；只给“继续等待 / 关闭窗口”，打开后再点按钮只作说明', async () => {
  const events = { progress: [], warnings: [], infos: [], commands: [] };
  const answers = [];
  const vscode = {
    ProgressLocation: { Notification: 15 },
    window: {
      withProgress: async (options, task) => {
        events.progress.push(['open', options.title]);
        await task({ report: (value) => events.progress.push(['report', value.message]) });
        events.progress.push(['closed']);
      },
      showWarningMessage: (message, ...actions) => {
        events.warnings.push({ message, actions });
        return answers.shift() ?? new Promise(() => {});
      },
      showInformationMessage: async (message) => { events.infos.push(message); }
    },
    commands: { executeCommand: async (id) => { events.commands.push(id); } }
  };
  const opening = loadLayerModule('vscode/runtimeOpeningWait.ts', { vscode });
  const describe = (wait) => ({ ...opening.describeRuntimeOpeningWait(wait) });
  const other = describe({ waitedMs: 1_500, holderWaitedMs: 1_500 });
  assert.deepEqual({ ...other.status }, {
    title: '正在等待其它窗口', description: '正在等待其它 LimCode 窗口释放数据目录，完成后自动打开；未发送的输入已保留。'
  });
  assert.equal(other.message, '正在等待其它 LimCode 窗口释放数据目录（已等待 2 秒），完成后自动打开；未发送的输入已保留。');
  const migrating = { operation: 'data-root-migration', description: '迁移数据目录', runningMs: 12_400, heartbeatAgeMs: 800, stale: false };
  const plain = describe({ waitedMs: 3_000, holderWaitedMs: 3_000, activity: migrating });
  assert.equal(plain.status.description, '另一个窗口正在迁移数据目录，完成后自动打开；未发送的输入已保留。');
  assert.equal(plain.message, '另一个窗口正在迁移数据目录（已进行 12 秒），完成后自动打开；未发送的输入已保留。');
  const staged = describe({ waitedMs: 3_000, holderWaitedMs: 3_000, activity: { ...migrating, stage: '正在复制正文（3/10）', runningMs: 300_000 } });
  assert.equal(staged.status.description, '另一个窗口正在迁移数据目录（正在复制正文（3/10）），完成后自动打开；未发送的输入已保留。');
  assert.equal(staged.message, '另一个窗口正在迁移数据目录（已进行 5 分钟，正在复制正文（3/10）），完成后自动打开；未发送的输入已保留。');
  assert.equal(plain.warning, undefined);
  assert.match(describe({ waitedMs: 11 * 60_000, holderWaitedMs: 11 * 60_000, activity: migrating }).warning,
    /本窗口已等待 11 分钟。本窗口会继续等它结束，不会跳过它直接打开；也可以关闭本窗口。/);
  // Judged by the current holder: a window queued behind a long maintenance is not warned when the
  // next window (which publishes nothing while it opens) takes the lock.
  assert.equal(describe({ waitedMs: 62_000, holderWaitedMs: 900 }).warning, undefined);
  assert.equal(describe({ waitedMs: 11 * 60_000, holderWaitedMs: 4 * 60_000, activity: migrating }).warning, undefined,
    'a maintenance that took over from an earlier holder is timed from its own start');
  assert.match(describe({ waitedMs: 62_000, holderWaitedMs: 61_000 }).warning, /另一个 LimCode 窗口已经占用数据目录 61 秒/);
  const stale = describe({ waitedMs: 20_000, holderWaitedMs: 20_000, activity: { ...migrating, heartbeatAgeMs: 31_000, stale: true } });
  assert.equal(stale.status.description, '另一个窗口正在迁移数据目录，但暂时没有进展（可能卡在网络盘或外置盘上）；完成后自动打开；未发送的输入已保留。');
  assert.match(stale.message, /已经 31 秒没有进展/);
  assert.match(stale.warning, /不会跳过它直接打开/);

  const statuses = [];
  const presenter = opening.createRuntimeOpeningWaitPresenter((status) => statuses.push(status && { ...status }));
  // Every second a new elapsed time: the notification follows, the shell does not.
  for (let second = 1; second <= 5; second += 1) presenter.onWait({ waitedMs: second * 1_000, holderWaitedMs: second * 1_000, activity: { ...migrating, runningMs: second * 1_000 } });
  presenter.onWait({ waitedMs: 6_000, holderWaitedMs: 6_000, activity: { ...migrating, runningMs: 6_000, stage: '正在核对' } });
  assert.deepEqual(statuses.map((status) => status.description), [
    '另一个窗口正在迁移数据目录，完成后自动打开；未发送的输入已保留。',
    '另一个窗口正在迁移数据目录（正在核对），完成后自动打开；未发送的输入已保留。'
  ], 'the shell is redrawn only when the stage changes');
  assert.equal(events.progress.filter((entry) => entry[0] === 'report').length, 6, 'the notification shows every second');
  assert.equal(events.progress.filter((entry) => entry[0] === 'open').length, 1, 'one notification for the whole wait');
  // The holder stopped making progress: warned once; the user keeps waiting, then no new warning at once.
  answers.push('继续等待');
  presenter.onWait({ waitedMs: 30_000, holderWaitedMs: 30_000, activity: { ...migrating, heartbeatAgeMs: 20_000, stale: true } });
  await delay(10);
  presenter.onWait({ waitedMs: 31_000, holderWaitedMs: 31_000, activity: { ...migrating, heartbeatAgeMs: 21_000, stale: true } });
  await delay(10);
  assert.equal(events.warnings.length, 1);
  assert.deepEqual([...events.warnings[0].actions], ['继续等待', '关闭窗口']);
  assert.deepEqual(events.commands, [], 'keeps waiting: never opens past the lock');
  presenter.end();
  await delay(10);
  assert.equal(statuses.at(-1), undefined);
  assert.deepEqual(events.progress.at(-1), ['closed']);

  // Known at once (a data-directory move recorded as running): shown before any wait was measured.
  const announced = [];
  const early = opening.createRuntimeOpeningWaitPresenter((status) => announced.push(status?.description));
  early.announce('正在迁移数据目录，完成后自动打开；未发送的输入已保留。');
  early.onWait({ waitedMs: 1_000, holderWaitedMs: 1_000, activity: migrating });
  early.end();
  assert.deepEqual(announced, ['正在迁移数据目录，完成后自动打开；未发送的输入已保留。',
    '另一个窗口正在迁移数据目录，完成后自动打开；未发送的输入已保留。', undefined]);

  // “关闭窗口” closes this window while it waits.
  const closing = opening.createRuntimeOpeningWaitPresenter(() => {});
  answers.push('关闭窗口');
  closing.onWait({ waitedMs: 30_000, holderWaitedMs: 30_000, activity: { ...migrating, heartbeatAgeMs: 20_000, stale: true } });
  await delay(10);
  assert.deepEqual(events.commands, ['workbench.action.closeWindow']);
  closing.end();

  // A warning still open when the window opened: a button pressed afterwards is answered, nothing else.
  let answer;
  answers.push(new Promise((resolve) => { answer = resolve; }));
  const late = opening.createRuntimeOpeningWaitPresenter(() => {});
  late.onWait({ waitedMs: 70_000, holderWaitedMs: 61_000 });
  late.end();
  answer('关闭窗口');
  await delay(10);
  assert.deepEqual(events.commands, ['workbench.action.closeWindow'], 'not closed after it opened');
  assert.deepEqual(events.infos, ['LimCode 已经打开，不需要再等待；本窗口没有关闭。']);
});

test('大库会话：标记带预计结束时间时外壳写“预计 HH:MM 前完成”，心跳正常时 10 分钟告警推迟到预计时长的 1.5 倍；超过预计时间改说比预计的慢；心跳停了立即告警、不再推迟', async () => {
  const vscode = {
    ProgressLocation: { Notification: 15 },
    window: { withProgress: async () => {}, showWarningMessage: () => new Promise(() => {}), showInformationMessage: async () => {} },
    commands: { executeCommand: async () => {} }
  };
  const opening = loadLayerModule('vscode/runtimeOpeningWait.ts', { vscode });
  assert.equal(opening.RUNTIME_OPENING_WAIT_LIMITS.expectedEndStretch, 1.5);
  const describe = (wait) => ({ ...opening.describeRuntimeOpeningWait(wait) });
  const expectedEndAt = new Date(2026, 8, 27, 14, 32, 0).toISOString();
  // Expected to take 30 minutes; 12 minutes in, this window has waited 11 minutes.
  const merging = {
    operation: 'historical-merge', description: '合并较大的旧聊天记录', stage: '第 2/4 份，已完成 35%',
    runningMs: 12 * 60_000, heartbeatAgeMs: 900, stale: false, expectedEndAt, expectedTotalMs: 30 * 60_000
  };
  const early = describe({ waitedMs: 11 * 60_000, holderWaitedMs: 11 * 60_000, activity: merging });
  assert.equal(early.status.description,
    '另一个窗口正在合并较大的旧聊天记录（第 2/4 份，已完成 35%），预计 14:32 前完成，完成后自动打开；未发送的输入已保留。');
  assert.equal(early.message,
    '另一个窗口正在合并较大的旧聊天记录（已进行 12 分钟，第 2/4 份，已完成 35%，预计 14:32 前完成），完成后自动打开；未发送的输入已保留。');
  assert.equal(early.warning, undefined, 'postponed: the maintenance keeps its heartbeat and is within its expected time');
  // Past the expected end but not yet 1.5 times as long: said so, still not warned.
  const slow = describe({ waitedMs: 40 * 60_000, holderWaitedMs: 40 * 60_000, activity: { ...merging, runningMs: 40 * 60_000 } });
  assert.equal(slow.status.description,
    '另一个窗口正在合并较大的旧聊天记录（第 2/4 份，已完成 35%），比预计的慢，仍在进行，完成后自动打开；未发送的输入已保留。');
  assert.equal(slow.warning, undefined);
  // 1.5 times the expected time: the usual warning.
  assert.match(describe({ waitedMs: 45 * 60_000, holderWaitedMs: 45 * 60_000, activity: { ...merging, runningMs: 45 * 60_000 } }).warning,
    /另一个 LimCode 窗口正在合并较大的旧聊天记录，本窗口已等待 45 分钟。本窗口会继续等它结束/);
  // Never earlier than without an expected end: a short expected time still waits the 10 minutes.
  const quick = { ...merging, runningMs: 9 * 60_000, expectedTotalMs: 60_000 };
  assert.equal(describe({ waitedMs: 9 * 60_000, holderWaitedMs: 9 * 60_000, activity: quick }).warning, undefined);
  assert.match(describe({ waitedMs: 10 * 60_000, holderWaitedMs: 10 * 60_000, activity: { ...quick, runningMs: 10 * 60_000 } }).warning, /已等待 10 分钟/);
  // The heartbeat stopped: warned at once, however long it was expected to take.
  const stale = describe({ waitedMs: 60_000, holderWaitedMs: 60_000, activity: { ...merging, runningMs: 60_000, heartbeatAgeMs: 20_000, stale: true } });
  assert.match(stale.warning, /已经 20 秒没有进展/);
  // Without an expected end nothing changes (the migration's wording and its 10 minutes).
  const { expectedEndAt: _end, expectedTotalMs: _total, ...plain } = merging;
  assert.equal(describe({ waitedMs: 1_000, holderWaitedMs: 1_000, activity: plain }).status.description,
    '另一个窗口正在合并较大的旧聊天记录（第 2/4 份，已完成 35%），完成后自动打开；未发送的输入已保留。');
  assert.match(describe({ waitedMs: 11 * 60_000, holderWaitedMs: 11 * 60_000, activity: plain }).warning, /已等待 11 分钟/);
});

test('盲审 #9：拿到锁之后等待提示立即收起、外壳不再说在等待（不与随后的选择框并存）；之后再等别的锁时重新提示；收起后才点的警告按钮只作说明', async () => {
  const events = { progress: [], infos: [], commands: [] };
  const answers = [];
  const vscode = {
    ProgressLocation: { Notification: 15 },
    window: {
      withProgress: async (options, task) => {
        events.progress.push(['open', options.title]);
        await task({ report: () => {} });
        events.progress.push(['closed']);
      },
      showWarningMessage: () => answers.shift() ?? new Promise(() => {}),
      showInformationMessage: async (message) => { events.infos.push(message); }
    },
    commands: { executeCommand: async (id) => { events.commands.push(id); } }
  };
  const opening = loadLayerModule('vscode/runtimeOpeningWait.ts', { vscode });
  const migrating = { operation: 'data-root-migration', description: '迁移数据目录', stage: '正在切换到新数据目录', runningMs: 9_000, heartbeatAgeMs: 500, stale: false };
  const statuses = [];
  const presenter = opening.createRuntimeOpeningWaitPresenter((status) => statuses.push(status?.description));
  presenter.announce('正在迁移数据目录，完成后自动打开；未发送的输入已保留。');
  presenter.onWait({ waitedMs: 1_000, holderWaitedMs: 1_000, activity: migrating });
  presenter.settle();
  await delay(10);
  assert.deepEqual(events.progress, [['open', 'LimCode 正在等待另一个窗口'], ['closed']]);
  assert.equal(statuses.at(-1), undefined, 'the shell no longer says it waits while the Runtime opens');
  presenter.settle();
  // Another claim waited for afterwards (another window opening): shown anew.
  presenter.onWait({ waitedMs: 1_200, holderWaitedMs: 1_200 });
  await delay(10);
  assert.deepEqual(events.progress.at(-1), ['open', 'LimCode 正在等待其它窗口']);
  presenter.end();
  await delay(10);
  assert.deepEqual(events.progress.at(-1), ['closed']);
  assert.deepEqual(statuses, ['正在迁移数据目录，完成后自动打开；未发送的输入已保留。',
    '另一个窗口正在迁移数据目录（正在切换到新数据目录），完成后自动打开；未发送的输入已保留。', undefined,
    '正在等待其它 LimCode 窗口释放数据目录，完成后自动打开；未发送的输入已保留。', undefined]);
  // A warning still open when the wait was over: a button pressed then is answered, nothing closes.
  let answer;
  answers.push(new Promise((resolve) => { answer = resolve; }));
  const warned = opening.createRuntimeOpeningWaitPresenter(() => {});
  warned.onWait({ waitedMs: 30_000, holderWaitedMs: 30_000, activity: { ...migrating, heartbeatAgeMs: 20_000, stale: true } });
  warned.settle();
  answer('关闭窗口');
  await delay(10);
  assert.deepEqual(events.commands, []);
  assert.deepEqual(events.infos, ['LimCode 已经不需要再等待，正在打开；本窗口没有关闭。']);
  warned.end();
});

test('用户的操作让先给较早的请求后，只有为那个请求让出时才把原因带过重载；自动调用与别的请求都不带', async (t) => {
  const { binding, paths } = await createRoot(t);
  const state = new Map();
  const windowState = { get: (key) => state.get(key), update: async (key, value) => { if (value === undefined) state.delete(key); else state.set(key, value); } };
  let reloads = 0;
  const layer = loadVscodeLayer(vscodeMock({ titles: [], notices: [] }, () => { reloads += 1; }));
  const liveness = await publishHost(binding, 'window-b');
  const participant = layer.startExclusiveMaintenanceParticipant({
    exclusiveMaintenanceTarget: () => ({ paths, hostBootId: 'window-b' }), hasOwnedExecution: async () => false
  }, { countdownSeconds: 0, pollMs: 60 * 60_000, processId: (nextFakeProcessId += 1), windowState });
  t.after(async () => { await participant.dispose(); await fs.rm(liveness, { force: true }); });
  // Another window with a running Turn: B's requests are published and wait.
  const working = await layerWindow(t, binding, 'window-c', { work: true });
  const earlier = { requestId: 'earlier-request', createdAt: '2020-01-01T00:00:00.000Z', whenBusy: 'wait', confirmation: 'notice' };
  const other = (id) => ({ ...earlier, requestId: id, createdAt: '2020-01-01T00:00:01.000Z' });
  const ask = (ignoreBackoff, whenBusy = 'wait') => layer.runWithExclusiveMaintenance(paths, {
    ...MERGE, operation: 'historical-merge', operationKey: `source-${ignoreBackoff}`, message: '为合并较大的旧聊天记录',
    waitingTitle: '等待', ignoreBackoff, whenBusy, requesterHostBootId: 'window-b', pollMs: 10, isCurrent: () => true,
    withLocks: (body) => withRuntimeMaintenance(paths, body)
  }, async () => assert.fail('must not run'));
  const walk = async (request) => {
    for (const phase of ['prepare', 'confirm', 'go']) {
      await writeRequest(paths, { ...request, phase });
      await participant.checkNow();
    }
  };
  // The user's operation that did not run for another reason (window C is busy): nothing is kept.
  assert.equal((await ask(true, 'abandon')).state, 'busy');
  await walk(other('request-1'));
  await delay(20);
  assert.equal(reloads, 1);
  assert.equal(layer.takeNoticeKeptAcrossReload(windowState), undefined);
  await writeRequest(paths, earlier);
  // An automatic call gives way too, but nothing is kept for it.
  assert.equal((await ask(false)).gaveWayTo, 'earlier-request');
  await walk(other('request-2'));
  await delay(20);
  assert.equal(reloads, 2);
  assert.equal(layer.takeNoticeKeptAcrossReload(windowState), undefined);
  // Yielding to another request than the one given way to keeps nothing either.
  const clicked = await ask(true);
  assert.equal(clicked.gaveWayTo, 'earlier-request');
  await walk(other('request-3'));
  await delay(20);
  assert.equal(reloads, 3);
  assert.equal(layer.takeNoticeKeptAcrossReload(windowState), undefined);
  // Yielding to the request the user's operation gave way to keeps the reason, once.
  await walk(earlier);
  await delay(20);
  assert.equal(reloads, 4);
  assert.equal(working.reloads, 0);
  assert.match(layer.takeNoticeKeptAcrossReload(windowState), /^合并较大的旧聊天记录没有进行：另一个窗口先发起了整理数据/);
  assert.equal(layer.takeNoticeKeptAcrossReload(windowState), undefined, 'read once');
});

test('盲审 #5：带过重载的原因按窗口重新打开的时间判断有效期，等维护结束的时间不算', async () => {
  const layer = loadVscodeLayer(vscodeMock({ titles: [], notices: [] }, () => {}));
  const stateWith = (value) => {
    const state = new Map([['limcode.exclusiveMaintenance.noticeAfterReload', value]]);
    return { get: (key) => state.get(key), update: async (key, next) => { if (next === undefined) state.delete(key); else state.set(key, next); } };
  };
  const text = '迁移数据目录没有进行：另一个窗口先发起了合并旧聊天记录';
  // Reloaded 30 minutes ago, reopened a second later, then waited for a long migration to end.
  const keptAt = Date.now() - 30 * 60_000;
  assert.equal(layer.takeNoticeKeptAcrossReload(stateWith({ text, at: keptAt }), keptAt + 1_000), text);
  // A window that opened again 11 minutes after the notice was kept: not that reload.
  assert.equal(layer.takeNoticeKeptAcrossReload(stateWith({ text, at: keptAt }), keptAt + 11 * 60_000), undefined);
  const state = stateWith({ text, at: keptAt });
  assert.equal(layer.takeNoticeKeptAcrossReload(state), undefined, 'without the reopening time it counts from now');
  assert.equal(state.get('limcode.exclusiveMaintenance.noticeAfterReload'), undefined, 'read and cleared either way');
});

test('盲审 #10：确认重载前让面板立即保存未发送的输入：确认开始时一次，重载前再一次并留出写入的时间', async (t) => {
  const { binding, paths } = await createRoot(t);
  const log = [];
  const layer = loadVscodeLayer(vscodeMock({ titles: [], notices: [] }, () => { log.push(['reload', Date.now()]); }));
  const liveness = await publishHost(binding, 'window-drafts');
  const participant = layer.startExclusiveMaintenanceParticipant({
    exclusiveMaintenanceTarget: () => ({ paths, hostBootId: 'window-drafts' }), hasOwnedExecution: async () => false
  }, {
    countdownSeconds: 0, pollMs: 60 * 60_000, processId: (nextFakeProcessId += 1),
    saveDrafts: () => { log.push(['save', Date.now()]); return 1; }
  });
  t.after(async () => { await participant.dispose(); await fs.rm(liveness, { force: true }); });
  const request = { requestId: 'draft-request', createdAt: new Date().toISOString(), whenBusy: 'wait', confirmation: 'notice' };
  for (const phase of ['prepare', 'confirm', 'go']) {
    await writeRequest(paths, { ...request, phase });
    await participant.checkNow();
  }
  for (let polls = 0; polls < 100 && !log.some(([kind]) => kind === 'reload'); polls += 1) await delay(10);
  assert.deepEqual(log.map(([kind]) => kind), ['save', 'save', 'reload']);
  assert.ok(log[2][1] - log[1][1] >= 200, `the writes get time before the reload (${log[2][1] - log[1][1]} ms)`);
});

test('打开外壳读取启动等待原因：变化时通知，运行时就绪后不再接受', async () => {
  const { ApplicationStartup } = require(path.join(compiled, 'vscode/ApplicationStartup.js'));
  const startup = new ApplicationStartup();
  const seen = [];
  const subscription = startup.onDidChangeWaiting((status) => seen.push(status));
  const status = { title: '正在等待另一个窗口', description: '另一个窗口正在迁移数据目录（已进行 3 秒），完成后自动打开；未发送的输入已保留。' };
  startup.reportWaiting(status);
  assert.deepEqual(startup.waiting(), status);
  startup.reportWaiting(undefined);
  startup.resolve({});
  startup.reportWaiting(status);
  subscription.dispose();
  startup.reportWaiting(undefined);
  assert.deepEqual(seen, [status, undefined]);
  assert.equal(startup.waiting(), undefined);
});

// ---------------------------------------------------------------------------------------------
// Part 2: every window is its own process, opened like a real startup.
// ---------------------------------------------------------------------------------------------

test('多进程：两个空闲窗口都倒计时确认之后才统一重载，全部下线后才执行', async (t) => {
  const fixture = await createRoot(t);
  const windows = createWindows(t, fixture.root, { noMerge: true });
  await Promise.all([windows.start('A'), windows.start('B')].map((window) => window.then((item) => item.waitFor('ready'))));
  let operationAt;
  const outcome = await withRuntimeMaintenance(fixture.paths, () => requestExclusiveRuntimeMaintenance(fixture.paths, {
    ...MERGE, pollMs: 20
  }, async () => { operationAt = Date.now(); return 'merged'; }));
  await delay(200);
  await windows.stop();
  assert.deepEqual(outcome, { state: 'completed', result: 'merged', coordinated: true });
  assert.deepEqual(windows.reloads(), { A: 1, B: 1 });
  const countdowns = windows.events().filter((event) => event.event === 'progress' && /即将重载/.test(event.title)).map((event) => event.at);
  const reloads = windows.events().filter((event) => event.event === 'reload').map((event) => event.at);
  assert.equal(countdowns.length, 2);
  assert.ok(Math.max(...countdowns) <= Math.min(...reloads), 'nobody reloads before everybody confirmed');
  assert.ok(Math.max(...reloads) <= operationAt, 'the operation runs only after every window went offline');
});

test('多进程：一个窗口长期有任务时，后台合并请求立即放弃，任何窗口都不倒计时、不重载', async (t) => {
  const fixture = await createFixture(t);
  await seed(fixture.alpha, ['conversation_alpha_1', 'conversation_alpha_2']);
  const windows = createWindows(t, fixture.root, { limits: LIMITS });
  await (await windows.start('B', { busy: true, noMerge: true })).waitFor('ready');
  await (await windows.start('A', { noMerge: true })).waitFor('ready');
  const c = await windows.start('C');
  const report = await c.waitFor('report');
  await delay(1_000);
  await windows.stop();
  assert.deepEqual(windows.reloads(), { B: 0, A: 0, C: 0 });
  assert.deepEqual(report.deferred, ['runtime-data-set-merge-exclusive-busy']);
  assert.equal(windows.events().filter((event) => event.event === 'progress' && /即将重载/.test(event.title)).length, 0);
});

test('多进程：旧版本窗口（不参与协作）在场时立即放弃，不发布请求', async (t) => {
  const fixture = await createRoot(t);
  const windows = createWindows(t, fixture.root, { noMerge: true });
  await (await windows.start('idle')).waitFor('ready');
  await (await windows.start('legacy', { participant: false })).waitFor('ready');
  const outcome = await withRuntimeMaintenance(fixture.paths, () => requestExclusiveRuntimeMaintenance(fixture.paths, {
    ...MERGE, pollMs: 20, prepareTimeoutMs: 500
  }, async () => assert.fail('must not run')));
  await delay(200);
  await windows.stop();
  assert.equal(outcome.state, 'legacy-host');
  assert.deepEqual(outcome.hosts.map((host) => host.hostBootId), ['legacy-boot-1']);
  assert.deepEqual(windows.reloads(), { idle: 0, legacy: 0 });
  assert.equal(windows.events().filter((event) => event.event === 'progress').length, 0);
});

test('多进程：有窗口的用户取消倒计时则放弃，没有任何窗口重载', async (t) => {
  const fixture = await createRoot(t);
  const windows = createWindows(t, fixture.root, { noMerge: true });
  await (await windows.start('keep', { cancelCountdown: true })).waitFor('ready');
  await (await windows.start('other')).waitFor('ready');
  const outcome = await withRuntimeMaintenance(fixture.paths, () => requestExclusiveRuntimeMaintenance(fixture.paths, {
    ...MERGE, pollMs: 20
  }, async () => assert.fail('must not run')));
  await delay(300);
  await windows.stop();
  assert.equal(outcome.state, 'declined');
  assert.deepEqual(windows.reloads(), { keep: 0, other: 0 });
});

test('多进程：迁移由运行中的窗口在锁外发起——等自己和其它窗口的任务结束，期间新窗口能打开，其它窗口倒计时不可取消，自己不重载', async (t) => {
  const fixture = await createRoot(t);
  const windows = createWindows(t, fixture.root, { noMerge: true });
  await (await windows.start('working', { busy: true, busyForMs: 2_500 })).waitFor('ready');
  await (await windows.start('idle', { cancelCountdown: true })).waitFor('ready');
  const requester = await windows.start('requester', { request: true, busy: true, busyForMs: 1_500 });
  await requester.waitFor('progress');
  // While the requester waits (no locks held), a new window opens its Runtime normally.
  const openedAt = Date.now();
  const late = await windows.start('late');
  await late.waitFor('ready', 10_000);
  const openedWithin = Date.now() - openedAt;
  const coordination = await requester.waitFor('coordination', 30_000);
  await windows.stop();
  assert.ok(openedWithin < 8_000, `a new window opened after ${openedWithin} ms`);
  assert.equal(coordination.state, 'completed');
  assert.deepEqual(windows.reloads(), { working: 1, idle: 1, requester: 0, late: 1 });
  const operation = windows.events().find((event) => event.event === 'operation');
  const workingEnd = windows.events().find((event) => event.name === 'working' && event.event === 'opened').startedAt + 2_500;
  assert.ok(operation.at >= workingEnd, 'the working window finished first');
  const countdowns = windows.events().filter((event) => event.event === 'progress' && /即将重载/.test(event.title));
  assert.ok(countdowns.length >= 3 && countdowns.every((event) => event.cancellable === false), JSON.stringify(countdowns));
  assert.equal(windows.events().filter((event) => event.name === 'requester' && event.event === 'progress' && /即将重载/.test(event.title)).length, 0);
  assert.deepEqual(windows.events().filter((event) => event.name === 'working' && event.event === 'notice' && /自动重载/.test(event.message)).map((event) => event.message),
    ['为迁移数据目录：本窗口的任务结束后会自动重载，未发送的输入会保留。']);
});

test('多进程（盲审 #1）：迁移在锁外等一个忙窗口时用户关掉或重载它——关闭期间它按“离开中”缺席处理而不是旧版本窗口，迁移继续完成', async (t) => {
  for (const variant of ['close', 'reload']) {
    const fixture = await createRoot(t);
    const windows = createWindows(t, fixture.root, { noMerge: true });
    const userAction = variant === 'close'
      ? { closeAfterMs: 4_000, closeGapMs: 800 }
      : { reloadAfterMs: 4_000, closeGapMs: 800, afterReload: { busy: false, reloadAfterMs: 0 } };
    await (await windows.start('busy', { busy: true, ...userAction })).waitFor('ready');
    // A short registration grace: by the time the user acts, the busy window counts as one used for a while.
    const requester = await windows.start('requester', { request: true, requestOptions: { prepareTimeoutMs: 1_500 } });
    const coordination = await requester.waitFor('coordination', 60_000);
    await windows.stop();
    assert.equal(coordination.state, 'completed', `${variant}: ${coordination.state} ${coordination.reason}`);
    const events = windows.events();
    const acted = events.find((event) => event.name === 'busy' && event.boot === 1 && event.event === (variant === 'close' ? 'closing' : 'reload'));
    const waiting = events.find((event) => event.name === 'requester' && event.event === 'progress');
    const operation = events.find((event) => event.name === 'requester' && event.event === 'operation');
    assert.ok(acted && waiting && waiting.at < acted.at, 'the requester was waiting outside the locks when the user acted');
    assert.ok(operation.at > acted.at + 800, 'the operation ran only after the window closed its Runtime');
    if (variant === 'close') assert.deepEqual(windows.reloads(), { busy: 0, requester: 0 });
    else assert.ok(windows.reloads().busy >= 1 && windows.reloads().requester === 0, JSON.stringify(windows.reloads()));
  }
});

test('多进程（盲审 #4）：两个窗口同时启动、各自自动合并同一个超限来源——较新的请求直接让先（不提示、不记退避），另一方完成合并，没有“有任务正在进行”的误报', async (t) => {
  const fixture = await createFixture(t);
  await seed(fixture.alpha, ['conversation_alpha_1', 'conversation_alpha_2']);
  const windows = createWindows(t, fixture.root, { limits: LIMITS });
  await Promise.all([windows.start('A'), windows.start('B')]);
  await Promise.all([windows.waitForEvent('A', 'report', 60_000), windows.waitForEvent('B', 'report', 60_000)]);
  await delay(1_500);
  await windows.stop();
  const coordination = windows.events().filter((event) => event.event === 'coordination');
  assert.ok(!coordination.some((event) => event.state === 'busy'), JSON.stringify(coordination));
  assert.equal(windows.reports().flatMap((report) => report.merged).length, 1, 'merged exactly once');
  assert.ok(!windows.reports().some((report) => report.deferredMessages.some((message) => /有任务正在进行/.test(message))),
    JSON.stringify(windows.reports()));
  const ledger = path.join(runtimeExclusiveMaintenanceDirectory(fixture.current.binding.paths), 'ledger');
  const entries = await fs.readdir(ledger).catch(() => []);
  const keys = [];
  for (const name of entries) keys.push(JSON.parse(await fs.readFile(path.join(ledger, name), 'utf8')));
  assert.deepEqual(keys.filter((entry) => entry.scope === 'key'), [], 'no backoff');
});

test('多进程：发起方进程崩溃后，残留请求不会让任何窗口倒计时，锁可以正常获取，残留由下一次请求清理', async (t) => {
  const fixture = await createRoot(t);
  const windows = createWindows(t, fixture.root, { noMerge: true });
  await (await windows.start('idle')).waitFor('ready');
  await (await windows.start('working', { busy: true })).waitFor('ready');
  const requester = await windows.start('requester', { request: true });
  await requester.waitFor('progress');
  await delay(300);
  await windows.kill('requester');
  await delay(500);
  assert.deepEqual(await readExclusiveMaintenanceRequests(fixture.paths), [], 'the crashed requester no longer counts');
  const outcome = await withRuntimeDataRootAdmission(fixture.root, () => withRuntimeMaintenance(fixture.paths, () =>
    requestExclusiveRuntimeMaintenance(fixture.paths, { ...MERGE, pollMs: 20 }, async () => assert.fail('must not run'))));
  await windows.stop();
  assert.equal(outcome.state, 'busy');
  assert.deepEqual(await fs.readdir(path.join(runtimeExclusiveMaintenanceDirectory(fixture.paths), 'requests')), []);
  assert.equal(windows.events().filter((event) => event.name === 'idle' && event.event === 'progress').length, 0);
  assert.deepEqual(windows.reloads(), { idle: 0, working: 0, requester: 0 });
});

test('复现改写（严重）：用户请求过的大来源在其它窗口让出后合并失败，不再无限互相重载', async (t) => {
  const fixture = await createFixture(t);
  await seed(fixture.alpha, ['conversation_alpha_1', 'conversation_alpha_2']);
  // The user chose "合并到当前库" for alpha (mergeNow -> requestRuntimeDataSetMerge).
  await requestRuntimeDataSetMerge(fixture.paths, {
    candidateId: fixture.alpha.id,
    expectedDataSetId: fixture.alpha.binding.dataSetId,
    expectedRootInstanceId: fixture.alpha.binding.rootInstanceId
  });
  const windows = createWindows(t, fixture.root, { limits: LIMITS, failCommit: true });
  const a = await windows.start('A');
  await a.waitFor('report');
  await windows.start('B');
  await delay(10_000);
  await windows.stop();
  const reloads = windows.reloads();
  // Before: within 25 s A reloaded 9–10 times and B 9 times, each round leaving a full backup.
  assert.ok(reloads.A + reloads.B <= 1, JSON.stringify(reloads));
  const coordination = windows.events().filter((event) => event.event === 'coordination').map((event) => event.state);
  // A alone: fails without anybody reloading; B: A reloads once and it fails; A again: backoff.
  assert.ok(coordination.includes('backoff'), JSON.stringify(coordination));
  for (const report of windows.reports()) assert.deepEqual(report.merged, []);
});

test('复审 merge2 #3：大来源的正文复制失败发生在协调之前，从不请求其它窗口让出', async (t) => {
  const fixture = await createFixture(t);
  await seed(fixture.alpha, ['conversation_alpha_1', 'conversation_alpha_2']);
  const windows = createWindows(t, fixture.root, { limits: LIMITS, failLink: true });
  await (await windows.start('B', { noMerge: true })).waitFor('ready');
  const report = await (await windows.start('A')).waitFor('report');
  await delay(500);
  await windows.stop();
  assert.deepEqual(report.deferred, ['EIO']);
  assert.deepEqual(windows.events().filter((event) => event.event === 'coordination'), []);
  assert.deepEqual(windows.reloads(), { B: 0, A: 0 });
});

test('复现改写：用户请求过的大来源遇到忙窗口时不在锁内等待，新窗口可以立即打开', async (t) => {
  const fixture = await createFixture(t);
  await seed(fixture.alpha, ['conversation_alpha_1', 'conversation_alpha_2']);
  await requestRuntimeDataSetMerge(fixture.paths, {
    candidateId: fixture.alpha.id,
    expectedDataSetId: fixture.alpha.binding.dataSetId,
    expectedRootInstanceId: fixture.alpha.binding.rootInstanceId
  });
  const windows = createWindows(t, fixture.root, { limits: LIMITS });
  await (await windows.start('B', { busy: true, noMerge: true })).waitFor('ready');
  const a = await windows.start('A');
  const coordination = await a.waitFor('coordination', 30_000);
  const startedC = Date.now();
  const c = await windows.start('C', { noMerge: true });
  await c.waitFor('opened', 10_000);
  const openedWithin = Date.now() - startedC;
  await windows.stop();
  assert.equal(coordination.state, 'busy');
  assert.ok(openedWithin < 8_000, `opened after ${openedWithin} ms`);
  assert.deepEqual(windows.reloads(), { B: 0, A: 0, C: 0 });
});

test('多进程（复审 MP5）：两个请求方同时在锁外等待时不互等——较新的请求让先并写明原因，较早的迁移完成；较新的窗口随后让出，重载后看到自己没有进行的原因', async (t) => {
  const fixture = await createRoot(t);
  const windows = createWindows(t, fixture.root, { noMerge: true });
  await (await windows.start('C', { busy: true, busyForMs: 5_000 })).waitFor('ready');
  // B: the user confirmed “迁移数据目录” here, then went to window D.
  const b = await windows.start('B', { request: true });
  await b.waitFor('progress', 30_000);
  // D: the user clicks another operation in window D that needs the other windows offline.
  const d = await windows.start('D', {
    request: true, windowStateFile: path.join(path.dirname(fixture.root), 'state-D.json'),
    requestOptions: { operation: 'historical-merge', operationKey: 'source@x', message: '为合并较大的旧聊天记录', participantConfirmation: 'notice', requesterBusy: undefined }
  });
  const dOutcome = await d.waitFor('coordination', 60_000);
  const bOutcome = await b.waitFor('coordination', 60_000);
  const kept = await windows.waitForEvent('D', 'kept-notice', 30_000);
  await windows.stop();
  assert.equal(dOutcome.state, 'busy');
  assert.match(dOutcome.reason, /^另一个窗口先发起了迁移数据目录，这次让它先完成/);
  assert.equal(bOutcome.state, 'completed', 'the earlier migration is never dropped');
  assert.deepEqual(windows.reloads(), { C: 1, B: 0, D: 1 });
  const dReload = windows.events().find((event) => event.name === 'D' && event.event === 'reload');
  assert.ok(dReload.at >= dOutcome.at, 'D yielded only after its own request ended');
  assert.match(kept.text, /^合并较大的旧聊天记录没有进行：另一个窗口先发起了迁移数据目录/);
});

test('多进程（复审 MP4）：用户已确认的操作不可否决——参与方用户点进倒计时的窗口不会让这一轮作废', async (t) => {
  const fixture = await createRoot(t);
  const windows = createWindows(t, fixture.root, { noMerge: true });
  await (await windows.start('W', { countdownSeconds: 1, focusOnCountdownMs: 1_500, participantPollMs: 50 })).waitFor('ready');
  const requester = await windows.start('R', { request: true });
  const coordination = await requester.waitFor('coordination', 60_000);
  await delay(300);
  await windows.stop();
  assert.equal(coordination.state, 'completed');
  const countdowns = windows.events().filter((event) => event.name === 'W' && event.event === 'progress' && event.countdown);
  assert.equal(countdowns.length, 1);
  assert.equal(windows.events().filter((event) => event.name === 'R' && event.event === 'locks-taken').length, 1);
  assert.equal(windows.reloads().W, 1);
});

test('多进程（复审 MP6）：go 阶段有窗口又变忙时这次调用结束——每个窗口最多重载一次，锁内只有一轮', async (t) => {
  const fixture = await createRoot(t);
  const windows = createWindows(t, fixture.root, { noMerge: true });
  await (await windows.start('F', { participantPollMs: 50 })).waitFor('ready');
  await (await windows.start('S', { participantPollMs: 400, workAfterConfirm: { delayMs: 60, forMs: 1_500, once: true } })).waitFor('ready');
  const requester = await windows.start('R', { request: true });
  const coordination = await requester.waitFor('coordination', 60_000);
  await delay(1_000);
  await windows.stop();
  assert.equal(coordination.state, 'busy');
  assert.match(coordination.reason, /^其它窗口开始让出后1 个其它窗口有任务正在进行，这次没有进行/);
  assert.equal(windows.events().filter((event) => event.name === 'R' && event.event === 'locks-taken').length, 1);
  const reloads = windows.reloads();
  assert.ok(reloads.F <= 1 && reloads.S === 0 && reloads.R === 0, JSON.stringify(reloads));
  assert.equal(windows.events().filter((event) => event.event === 'operation').length, 0);
});

test('多进程（复审 MP2）：用户点击的合并在其它窗口让出后提交失败——其它窗口只重载一次，刚重载后的再次点击被冷却挡住', async (t) => {
  const fixture = await createFixture(t);
  await seed(fixture.alpha, ['conversation_alpha_1', 'conversation_alpha_2']);
  await requestRuntimeDataSetMerge(fixture.paths, {
    candidateId: fixture.alpha.id,
    expectedDataSetId: fixture.alpha.binding.dataSetId,
    expectedRootInstanceId: fixture.alpha.binding.rootInstanceId
  });
  const windows = createWindows(t, fixture.root, { limits: LIMITS, failCommit: true });
  await (await windows.start('B', { noMerge: true })).waitFor('ready');
  const a = await windows.start('A', { explicit: fixture.alpha.id });
  await a.waitFor('report', 60_000);
  // A window opened after that go (like one that just yielded) clicks again.
  const again = await windows.start('A2', { explicit: fixture.alpha.id });
  await again.waitFor('report', 60_000);
  await delay(1_000);
  await windows.stop();
  const reloads = windows.reloads();
  assert.deepEqual([reloads.A, reloads.A2], [0, 0]);
  assert.ok(reloads.B <= 1, JSON.stringify(reloads));
  const clicks = windows.events().filter((event) => event.event === 'coordination' && event.requested);
  assert.equal(clicks.at(-1).name, 'A2');
  assert.equal(clicks.at(-1).state, 'backoff');
  assert.match(clicks.at(-1).reason, /暂不再次要求其它窗口重载。约 \d+ 分钟后（\d\d:\d\d 以后）可以再试。$/);
  assert.ok(Date.parse(clicks.at(-1).retryAfter) > Date.now());
  for (const report of windows.reports()) assert.deepEqual(report.merged, []);
});

test('多进程（复审 MP3）：用户点击的大来源遇到忙窗口时在锁外等待，新窗口随即打开，之后合并完成', async (t) => {
  const fixture = await createFixture(t);
  await seed(fixture.alpha, ['conversation_alpha_1', 'conversation_alpha_2']);
  const windows = createWindows(t, fixture.root, { limits: LIMITS });
  await (await windows.start('B', { busy: true, busyForMs: 6_000, noMerge: true })).waitFor('ready');
  const a = await windows.start('A', { explicit: fixture.alpha.id });
  await a.waitFor('progress', 30_000);
  const c = await windows.start('C', { noMerge: true });
  const opened = await c.waitFor('opened', 15_000);
  const report = await a.waitFor('report', 60_000);
  await windows.stop();
  assert.ok(opened.openMs < 3_000, `C opened after ${opened.openMs} ms`);
  assert.deepEqual(report.merged, [fixture.alpha.id]);
  assert.deepEqual(windows.reloads(), { B: 1, A: 0, C: 1 });
});

test('多进程：只有发起窗口自己忙时也等它（其它窗口空闲），操作在它的任务结束之后才执行', async (t) => {
  const fixture = await createRoot(t);
  const windows = createWindows(t, fixture.root, { noMerge: true });
  await (await windows.start('idle')).waitFor('ready');
  const requester = await windows.start('requester', { request: true, busy: true, busyForMs: 2_000 });
  const coordination = await requester.waitFor('coordination', 30_000);
  await windows.stop();
  assert.equal(coordination.state, 'completed');
  const operation = windows.events().find((event) => event.event === 'operation');
  const busyEnd = windows.events().find((event) => event.name === 'requester' && event.event === 'opened').startedAt + 2_000;
  assert.ok(operation.at >= busyEnd, 'the requester window finished its own work first');
});

test('多进程：迁移执行期间重载的窗口在打开外壳里看到“另一个窗口正在迁移数据目录（已进行 N 秒）”，结束后自动打开', async (t) => {
  const fixture = await createRoot(t);
  const windows = createWindows(t, fixture.root, { noMerge: true });
  await (await windows.start('W')).waitFor('ready');
  const requester = await windows.start('R', { request: true, operationMs: 4_000 });
  const coordination = await requester.waitFor('coordination', 30_000);
  const reopened = await windows.waitForEvent('W', 'opened', 30_000, 2);
  await windows.stop();
  assert.equal(coordination.state, 'completed');
  const statuses = windows.events().filter((event) => event.name === 'W' && event.boot === 2 && event.event === 'opening-status')
    .map((event) => event.description);
  assert.deepEqual(statuses, ['另一个窗口正在迁移数据目录，完成后自动打开；未发送的输入已保留。'], 'the shell text does not change while nothing but the time does');
  const released = windows.events().find((event) => event.name === 'R' && event.event === 'locks-released').at;
  assert.ok(reopened.at >= released, 'opened only after the maintenance let go of the locks');
});

test('多进程（复审 N1）：启动时的自动合并让先给另一个窗口的迁移，本窗口随后为迁移重载——不把自动调用的结果带过重载', async (t) => {
  const fixture = await createFixture(t);
  await seed(fixture.alpha, ['conversation_alpha_1', 'conversation_alpha_2']);
  await requestRuntimeDataSetMerge(fixture.paths, {
    candidateId: fixture.alpha.id,
    expectedDataSetId: fixture.alpha.binding.dataSetId,
    expectedRootInstanceId: fixture.alpha.binding.rootInstanceId
  });
  const windows = createWindows(t, fixture.root, { limits: LIMITS });
  await (await windows.start('C', { busy: true, busyForMs: 8_000, noMerge: true })).waitFor('ready');
  const b = await windows.start('B', { request: true });
  await b.waitFor('progress', 30_000);
  const a = await windows.start('A', { windowStateFile: path.join(path.dirname(fixture.root), `state-A-${randomUUID()}.json`) });
  await a.waitFor('report', 60_000);
  const migration = await b.waitFor('coordination', 60_000);
  await windows.waitForEvent('A', 'ready', 30_000, 2);
  await delay(500);
  await windows.stop();
  const coordination = windows.events().filter((event) => event.name === 'A' && event.event === 'coordination');
  assert.equal(coordination[0]?.requested, false, 'the automatic startup merge');
  assert.equal(migration.state, 'completed');
  assert.equal(windows.reloads().A, 1);
  assert.deepEqual(windows.events().filter((event) => event.name === 'A' && event.event === 'kept-notice'), []);
});

test('多进程（复审 N2）：迁移在其它窗口让出后失败，发起窗口随即重载；用户马上再试可以越过冷却并完成，其它窗口为新的一次操作再重载一次；刚让出的窗口自己点迁移仍被冷却挡住', async (t) => {
  const fixture = await createRoot(t);
  const windows = createWindows(t, fixture.root, { noMerge: true });
  await (await windows.start('W', {
    windowStateFile: path.join(path.dirname(fixture.root), 'state-W.json'),
    // W reopens after yielding and its user clicks “迁移数据目录” too (a new attempt, its own token).
    afterReload: { request: true, requestAfterMs: 100 }
  })).waitFor('ready');
  const r = await windows.start('R', {
    request: true, failOperation: 'ENOSPC', reloadAfterFailure: true,
    windowStateFile: path.join(path.dirname(fixture.root), 'state-R.json'),
    // The user freed space and clicks “迁移数据目录” again right after the window came back.
    afterReload: { request: true, requestAfterMs: 1_500, failOperation: false }
  });
  const first = await r.waitFor('coordination', 60_000);
  const other = await windows.waitForEvent('W', 'coordination', 60_000, 2);
  const retry = await windows.waitForEvent('R', 'coordination', 60_000, 2);
  await delay(300);
  await windows.stop();
  assert.equal(first.state, 'threw');
  assert.equal(other.state, 'backoff', JSON.stringify(other));
  assert.match(other.reason, /^刚刚已经为这项维护让其它窗口重载过一次，暂不再次要求其它窗口重载。约 10 分钟后（\d\d:\d\d 以后）可以再试。$/);
  assert.ok(other.at < retry.at, 'W asked before R retried');
  assert.equal(retry.state, 'completed', JSON.stringify(retry));
  assert.deepEqual(windows.reloads(), { W: 2, R: 1 }, 'one reload of W per user operation');
});

test('多进程（复审 N3）：长时间维护结束后排队的窗口依次打开；打开外壳只在阶段变化时重画', async (t) => {
  const fixture = await createRoot(t);
  const windows = createWindows(t, fixture.root, { noMerge: true });
  for (const name of ['W1', 'W2', 'W3']) await (await windows.start(name)).waitFor('ready');
  const r = await windows.start('R', { request: true, operationMs: 12_000 });
  await r.waitFor('coordination', 90_000);
  for (const name of ['W1', 'W2', 'W3']) await windows.waitForEvent(name, 'opened', 30_000, 2);
  await windows.stop();
  const released = windows.events().find((event) => event.name === 'R' && event.event === 'locks-released').at;
  const rows = ['W1', 'W2', 'W3'].map((name) => ({
    name,
    afterReleaseMs: windows.events().find((event) => event.name === name && event.boot === 2 && event.event === 'opened').at - released,
    shellUpdates: windows.events().filter((event) => event.name === name && event.boot === 2 && event.event === 'opening-status').length
  }));
  console.log('N3', JSON.stringify(rows));
  assert.ok(rows.every((row) => row.shellUpdates >= 1 && row.shellUpdates <= 2), JSON.stringify(rows));
});

test('多进程（大库会话）：首次启动倒计时后发起窗口冻结并关闭自己的运行时再合并；其它窗口不可否决地重载，在打开外壳里看到阶段与预计完成时间；完成后所有窗口都能打开，发起窗口重载后说明每一份', async (t) => {
  const fixture = await createRoot(t);
  const windows = createWindows(t, fixture.root, { noMerge: true });
  for (const name of ['W1', 'W2']) await (await windows.start(name)).waitFor('ready');
  await windows.start('R', {
    request: 'large-session', windowStateFile: path.join(path.dirname(fixture.root), 'R-state.json'),
    largeSources: [{ candidateId: 'workspace:large-1', rows: 300_000, mergeMs: 3_000 }, { candidateId: 'workspace:large-2', rows: 100_000, mergeMs: 3_000 }]
  });
  const kept = await windows.waitForEvent('R', 'kept-large-result', 90_000, 2);
  for (const name of ['W1', 'W2']) await windows.waitForEvent(name, 'opened', 30_000, 2);
  await windows.stop();
  const events = windows.events();
  const first = (name, event, boot = 1) => events.find((item) => item.name === name && item.event === event && item.boot === boot);
  // Other windows counted down without a cancel button (the startup prompt counted down in R) and reloaded once.
  for (const name of ['W1', 'W2']) {
    const countdown = events.find((item) => item.name === name && item.event === 'progress' && item.countdown);
    assert.equal(countdown?.cancellable, false, name);
  }
  assert.deepEqual(windows.reloads(), { W1: 1, W2: 1, R: 1 });
  // R froze itself before go, closed its Runtime, and only then the engine ran: both claims held, every Host offline.
  const frozen = first('R', 'frozen');
  assert.equal(frozen.activity, '合并较大的旧聊天记录');
  const closed = first('R', 'runtime-closed');
  const run = first('R', 'engine-run');
  assert.ok(frozen.at <= closed.at && closed.at <= run.at, JSON.stringify([frozen, closed, run]));
  assert.deepEqual([run.offline, run.admission, run.maintenance], ['offline', true, true]);
  for (const name of ['W1', 'W2']) assert.ok(first(name, 'reload').at <= run.at, `${name} reloaded before the merge`);
  // Windows waiting to open: the stage (source, progress in 5 % steps) and by when it should be done.
  const statuses = ['W1', 'W2'].flatMap((name) => events.filter((item) => item.name === name && item.boot === 2 && item.event === 'opening-status')
    .map((item) => item.description));
  assert.ok(statuses.some((text) => /^另一个窗口正在合并较大的旧聊天记录（第 [12]\/2 份，已完成 \d+%），预计 \d\d:\d\d 前完成，完成后自动打开；未发送的输入已保留。$/.test(text)),
    statuses.join('\n'));
  assert.ok(statuses.every((text) => !/已完成 \d*[1-46-9]%/.test(text)), 'progress in steps of 5 %');
  // The requesting window's progress notification changed at most every 0.5 s.
  const reports = events.filter((item) => item.name === 'R' && item.event === 'progress-report' && /^正在合并较大的旧聊天记录 /.test(item.message));
  assert.ok(reports.length >= 3, JSON.stringify(reports));
  for (let i = 1; i < reports.length; i += 1) assert.ok(reports[i].at - reports[i - 1].at >= 450, JSON.stringify(reports.slice(i - 1, i + 1)));
  // Every window opened once the maintenance let go of the locks.
  const released = events.find((item) => item.name === 'R' && item.event === 'locks-released');
  for (const name of ['W1', 'W2', 'R']) assert.ok(first(name, 'opened', 2).at >= released.at, name);
  // Told after R's reload: each source's conversations.
  assert.deepEqual(kept.merged, [['workspace:large-1', 10], ['workspace:large-2', 11]]);
  assert.match(kept.details[0], /^workspace:large-1（.+，约 30 万条记录）：新增 10 个对话。$/);
});

test('多进程（大库会话，手动开始）：确认后其它窗口只收到提示、不倒计时，发起窗口合并后重载，所有窗口都能打开', async (t) => {
  const fixture = await createRoot(t);
  const windows = createWindows(t, fixture.root, { noMerge: true });
  await (await windows.start('W')).waitFor('ready');
  await windows.start('R', {
    request: 'large-session', largeManual: true, windowStateFile: path.join(path.dirname(fixture.root), 'R-state.json'),
    largeSources: [{ candidateId: 'workspace:large-1', rows: 80_000, mergeMs: 600 }]
  });
  const kept = await windows.waitForEvent('R', 'kept-large-result', 90_000, 2);
  await windows.waitForEvent('W', 'opened', 30_000, 2);
  await windows.stop();
  const events = windows.events();
  // Confirmed first, with the size the batch measured (the duration comes with the preparation).
  assert.ok(events.some((item) => item.name === 'R' && item.event === 'warning' && /^合并较大的旧聊天记录（1 份，约 8 万条记录）？$/.test(item.message)), 'confirmed first');
  assert.ok(events.some((item) => item.name === 'W' && item.event === 'notice' && item.message === '为合并较大的旧聊天记录，本窗口将重载；未发送的输入会保留。'));
  assert.equal(events.some((item) => item.name === 'W' && item.event === 'progress' && item.countdown), false, 'no countdown in other windows');
  assert.deepEqual(windows.reloads(), { W: 1, R: 1 });
  assert.deepEqual(kept.merged, [['workspace:large-1', 10]]);
});

// ---------------------------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------------------------

/** A window of this process with the real VS Code layer; a reload closes it. */
async function layerWindow(t, binding, hostBootId, options = {}) {
  const window = {
    work: options.work === true, focused: options.focused === true, reloads: 0, titles: [], notices: [], cancellable: [],
    countdowns: () => window.titles.filter((title) => /本窗口即将重载/.test(title))
  };
  const liveness = await publishHost(binding, hostBootId);
  let participant;
  const mock = vscodeMock(window, async () => {
    window.reloads += 1;
    await participant?.dispose();
    participant = undefined;
    await fs.rm(liveness, { force: true });
  }, options.cancel === true);
  participant = loadVscodeLayer(mock).startExclusiveMaintenanceParticipant({
    exclusiveMaintenanceTarget: () => ({ paths: binding.paths, hostBootId }),
    hasOwnedExecution: async () => window.work
  }, { countdownSeconds: options.countdownSeconds ?? 0, pollMs: 15, processId: (nextFakeProcessId += 1) });
  await participant.checkNow();
  t.after(async () => {
    await participant?.dispose();
    await fs.rm(liveness, { force: true });
  });
  return window;
}

function vscodeMock(window, onReload, cancel = false) {
  return {
    ProgressLocation: { Notification: 15 },
    window: {
      state: { get focused() { return window.focused === true; } },
      withProgress: async (options, task) => {
        window.titles.push(options.title);
        if (/本窗口即将重载/.test(options.title)) window.cancellable?.push(options.cancellable === true);
        // The user presses "取消" at once where there is a cancel button.
        return task({ report() {} }, {
          get isCancellationRequested() { return cancel && options.cancellable === true; },
          onCancellationRequested() {}
        });
      },
      showInformationMessage: async (message) => { window.notices.push(message); }
    },
    commands: {
      executeCommand: async (id) => {
        if (id === 'workbench.action.reloadWindow') setImmediate(() => { void onReload(); });
      }
    }
  };
}

/** A request file of another requester (this process stands in for it). */
async function writeRequest(paths, overrides) {
  const file = path.join(runtimeExclusiveMaintenanceDirectory(paths), 'requests', `${overrides.requestId}.json`);
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file, JSON.stringify({
    kind: 'limcode-runtime-exclusive-maintenance-request', round: 1, phase: 'prepare', operation: 'offline-gc', operationKey: 'gc',
    message: '为整理数据', activity: '整理数据', confirmation: 'countdown', whenBusy: 'abandon', requesterProcessId: process.pid,
    requesterProcessStartIdentity: ownProcessStartIdentity(), heartbeatAt: new Date().toISOString(),
    expiresAt: new Date(Date.now() + 60_000).toISOString(), ...overrides
  }));
}

/** Loads a real VS Code layer module (TypeScript source) with the given dependencies. */
function loadLayerModule(file, dependencies) {
  const ts = require('typescript');
  const filename = path.resolve(file);
  const module = { exports: {} };
  vm.runInNewContext(ts.transpileModule(fsSync.readFileSync(filename, 'utf8'), {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS }
  }).outputText, {
    module, exports: module.exports, console, setInterval, clearInterval, setTimeout, clearTimeout, Promise,
    require(name) {
      if (!Object.prototype.hasOwnProperty.call(dependencies, name)) throw new Error(`Unexpected dependency ${name}`);
      return dependencies[name];
    }
  }, { filename });
  return module.exports;
}

/** Loads the real VS Code layer with a per-window vscode mock. */
function loadVscodeLayer(vscodeModule) {
  const ts = require('typescript');
  const filename = path.resolve('vscode/runtimeExclusiveMaintenance.ts');
  const module = { exports: {} };
  const dependencies = { vscode: vscodeModule, '../backend/reliableKernel/runtimeExclusiveMaintenance': exclusive };
  vm.runInNewContext(ts.transpileModule(fsSync.readFileSync(filename, 'utf8'), {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS }
  }).outputText, {
    module, exports: module.exports, console, setInterval, clearInterval, setTimeout, clearTimeout,
    require(name) {
      if (!Object.prototype.hasOwnProperty.call(dependencies, name)) throw new Error(`Unexpected dependency ${name}`);
      return dependencies[name];
    }
  }, { filename });
  return module.exports;
}

/** Window processes; a window that reloaded boots again, like VS Code replacing its Extension Host. */
function createWindows(t, root, defaults) {
  const state = { stopped: false, children: new Map(), events: [], boots: {}, behaviors: {} };
  async function start(name, behavior = {}) {
    state.behaviors[name] = behavior;
    state.boots[name] = (state.boots[name] ?? 0) + 1;
    const boot = state.boots[name];
    const env = { ...process.env };
    delete env.NODE_TEST_CONTEXT;
    env.LIMCODE_EXCLUSIVE_MAINTENANCE_WINDOW = JSON.stringify({ root, name, boot, behavior: { ...defaults, ...behavior } });
    const child = spawn(process.execPath, [WINDOW], { cwd: process.cwd(), env, stdio: ['ignore', 'pipe', 'pipe'] });
    state.children.set(name, child);
    const own = [];
    const listeners = new Set();
    let buffer = '';
    let stderr = '';
    child.stderr.setEncoding('utf8');
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (chunk) => {
      buffer += chunk;
      let newline;
      while ((newline = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, newline);
        buffer = buffer.slice(newline + 1);
        if (!line.startsWith('{')) continue;
        const event = JSON.parse(line);
        own.push(event);
        state.events.push(event);
        for (const listener of listeners) listener();
      }
    });
    child.once('exit', (code, signal) => {
      if (state.children.get(name) === child) state.children.delete(name);
      state.events.push({ name, boot, event: 'exit', code, signal, at: Date.now() });
      if (!state.stopped && own.some((event) => event.event === 'reload')) {
        // A reloaded window boots again, no longer as the requester or with the user's click.
        const { request: _request, explicit: _explicit, requestAfterMs: _after, afterReload, ...rest } = behavior;
        void start(name, { ...rest, ...(afterReload ?? {}) });
      }
    });
    return {
      waitFor: (eventName, timeoutMs = 20_000) => new Promise((resolve, reject) => {
        const check = () => {
          const found = own.find((event) => event.event === eventName);
          if (!found) return;
          listeners.delete(check);
          clearTimeout(timer);
          resolve(found);
        };
        const timer = setTimeout(() => {
          listeners.delete(check);
          reject(new Error(`${name} did not report ${eventName}: ${JSON.stringify(own)} ${stderr}`));
        }, timeoutMs);
        listeners.add(check);
        check();
      })
    };
  }
  const exitOf = (child) => new Promise((resolve) => {
    if (child.exitCode !== null || child.signalCode !== null) return resolve();
    child.once('exit', resolve);
    child.kill('SIGKILL');
  });
  async function stop() {
    if (state.stopped) return;
    state.stopped = true;
    await Promise.all([...state.children.values()].map(exitOf));
  }
  t.after(stop);
  return {
    start,
    stop,
    async kill(name) {
      const child = state.children.get(name);
      state.children.delete(name);
      if (child) await exitOf(child);
    },
    events: () => state.events,
    /** An event of any boot of this window (at least `boot`), also one still to come. */
    waitForEvent: (name, eventName, timeoutMs = 20_000, boot = 1) => new Promise((resolve, reject) => {
      const started = Date.now();
      const poll = () => {
        const found = state.events.find((event) => event.name === name && event.event === eventName && event.boot >= boot);
        if (found) return resolve(found);
        if (Date.now() - started > timeoutMs) return reject(new Error(`${name} did not report ${eventName}`));
        setTimeout(poll, 20);
      };
      poll();
    }),
    reports: () => state.events.filter((event) => event.event === 'report'),
    reloads: () => Object.fromEntries(Object.keys(state.boots).map((name) => [
      name, state.events.filter((event) => event.name === name && event.event === 'reload').length
    ]))
  };
}

async function createRoot(t) {
  const parent = await fs.mkdtemp(path.join(os.tmpdir(), 'limcode-exclusive-windows-'));
  t.after(() => fs.rm(parent, { recursive: true, force: true }));
  const root = path.join(parent, 'global');
  await fs.mkdir(root);
  const authority = new RootAuthority(() => resolveVscodeRuntimeDataRoot({ globalStoragePath: root }));
  const binding = await kernel.initializeEmptyRuntimeRoot(authority);
  return { root, binding, paths: binding.paths };
}

async function createFixture(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'limcode-exclusive-merge-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const paths = { globalStoragePath: root };
  const current = await initialize(root);
  const scope = resolveVscodeWorkspaceRuntimeScope({ workspaceFolderUris: ['file:///workspace/alpha'] });
  const scopeRoot = resolveVscodeWorkspaceRuntimeScopeRoot(paths, scope);
  await fs.mkdir(scopeRoot, { recursive: true });
  const alpha = { id: `workspace:${scope.key}`, ...await initialize(scopeRoot) };
  await selectVscodeRuntimeDataSet(paths, 'default');
  return { root, paths, current, alpha };
}

async function initialize(scopeRoot) {
  const authority = new RootAuthority(() => resolveVscodeRuntimeDataRoot({ globalStoragePath: scopeRoot }));
  const binding = await kernel.initializeEmptyRuntimeRoot(authority);
  return { authority, binding };
}

async function seed(dataSet, conversationIds) {
  const repo = (domain) => kernel.DOMAIN_REPOSITORIES.domain(domain);
  const runtime = await kernel.RuntimeDatabase.open(dataSet.authority, { hostBootId: `seed-${randomUUID()}` });
  const store = new kernel.ContentAddressedStore(dataSet.authority, dataSet.binding);
  try {
    for (const conversationId of conversationIds) {
      const content = await store.ingest(runtime, JSON.stringify({ role: 'user', parts: [{ text: `${conversationId} 的正文` }] }), MESSAGE_TYPE);
      const turnId = `${conversationId}_turn`;
      const messageId = `${conversationId}_message`;
      await runtime.transaction([
        repo('Conversation').insert({ id: conversationId, title: conversationId, status: 'active', created_at: NOW, updated_at: NOW }),
        ...projectFolderAssignmentSteps({ conversationId, folder: PROJECT, now: NOW }),
        repo('Turn').insert({ id: turnId, conversation_id: conversationId, status: 'terminated', created_at: NOW, updated_at: NOW, terminal_at: NOW }),
        repo('TurnTermination').insert({ id: `${conversationId}_termination`, turn_id: turnId, terminal_status: 'completed', reason: 'fixture', created_at: NOW }),
        repo('Message').insert({ id: messageId, created_at: NOW, updated_at: NOW, deleted_at: null }),
        repo('MessageRevision').insert({ id: `${messageId}_revision`, message_id: messageId, revision_seq: 1n, role: 'user', content_object_id: content.id, created_at: NOW }),
        repo('MessageCurrentRevisionLink').insert({ id: `${messageId}_current`, message_id: messageId, revision_id: `${messageId}_revision`, updated_at: NOW }),
        repo('MessagePartOfConversation').insert({ id: `${messageId}_member`, conversation_id: conversationId, message_id: messageId, message_seq: 1n, created_at: NOW })
      ]);
    }
  } finally { await runtime.close(); }
}

async function publishHost(binding, hostBootId, startedAt = STARTED) {
  const target = path.join(binding.paths.dataRootPath, `host-liveness/${hostBootId}.json`);
  await fs.mkdir(path.dirname(target), { recursive: true });
  await fs.writeFile(target, JSON.stringify({ kind: 'limcode-runtime-host-liveness', dataSetId: binding.dataSetId, rootInstanceId: binding.rootInstanceId,
    rootGeneration: binding.rootGeneration, hostBootId, livenessId: `${hostBootId}-liveness`, processId: process.pid,
    processStartIdentity: ownProcessStartIdentity(), startedAt, heartbeatAt: NOW }));
  return target;
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
