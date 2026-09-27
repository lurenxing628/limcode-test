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

test('发起方自身忙碌只看任务不看焦点（requesterWorkBusy）', async () => {
  const layer = loadVscodeLayer(vscodeMock({ titles: [], notices: [], focused: true }, () => {}));
  assert.equal(await layer.requesterWorkBusy({ hasOwnedExecution: async () => false })(), undefined);
  // Spread: the layer runs in its own vm realm.
  assert.deepEqual({ ...await layer.requesterWorkBusy({ hasOwnedExecution: async () => true })() },
    { kind: 'work', reason: '本窗口有任务正在进行' });
});

test('打开运行时等待时说明原因：持有方在做什么、已进行多久、阶段；只是另一个窗口在打开时照实说；等太久或没有进展时只给“继续等待 / 关闭窗口”', async () => {
  const events = { progress: [], warnings: [], commands: [] };
  const answers = [];
  const vscode = {
    ProgressLocation: { Notification: 15 },
    window: {
      withProgress: async (options, task) => {
        events.progress.push(['open', options.title]);
        await task({ report: (value) => events.progress.push(['report', value.message]) });
        events.progress.push(['closed']);
      },
      showWarningMessage: async (message, ...actions) => {
        events.warnings.push({ message, actions });
        return answers.shift();
      }
    },
    commands: { executeCommand: async (id) => { events.commands.push(id); } }
  };
  const opening = loadLayerModule('vscode/runtimeOpeningWait.ts', { vscode });
  const describe = (wait) => ({ ...opening.describeRuntimeOpeningWait(wait) });
  assert.deepEqual({ ...describe({ waitedMs: 1_500 }).status }, {
    title: '正在等待其它窗口', description: '正在等待其它窗口完成打开（已等待 2 秒），完成后自动打开；未发送的输入已保留。'
  });
  const migrating = { operation: 'data-root-migration', description: '迁移数据目录', runningMs: 12_400, heartbeatAgeMs: 800, stale: false };
  assert.equal(describe({ waitedMs: 3_000, activity: migrating }).status.description,
    '另一个窗口正在迁移数据目录（已进行 12 秒），完成后自动打开；未发送的输入已保留。');
  assert.equal(describe({ waitedMs: 3_000, activity: { ...migrating, stage: '正在复制正文（3/10）', runningMs: 300_000 } }).status.description,
    '另一个窗口正在迁移数据目录（已进行 5 分钟，正在复制正文（3/10）），完成后自动打开；未发送的输入已保留。');
  assert.equal(describe({ waitedMs: 3_000, activity: migrating }).warning, undefined);
  assert.match(describe({ waitedMs: 11 * 60_000, activity: migrating }).warning, /本窗口已等待 11 分钟。本窗口会继续等它结束，不会跳过它直接打开；也可以关闭本窗口。/);
  assert.match(describe({ waitedMs: 61_000 }).warning, /另一个窗口一直没有完成打开/);
  const stale = describe({ waitedMs: 20_000, activity: { ...migrating, heartbeatAgeMs: 31_000, stale: true } });
  assert.match(stale.status.description, /^另一个窗口正在迁移数据目录，已经 31 秒没有进展（可能卡在网络盘或外置盘上）/);
  assert.match(stale.warning, /不会跳过它直接打开/);

  const statuses = [];
  const presenter = opening.createRuntimeOpeningWaitPresenter((status) => statuses.push(status && { ...status }));
  presenter.onWait({ waitedMs: 1_000 });
  presenter.onWait({ waitedMs: 1_200 });
  presenter.onWait({ waitedMs: 2_000, activity: migrating });
  assert.deepEqual(statuses.map((status) => status.description), [
    '正在等待其它窗口完成打开（已等待 1 秒），完成后自动打开；未发送的输入已保留。',
    '另一个窗口正在迁移数据目录（已进行 12 秒），完成后自动打开；未发送的输入已保留。'
  ], 'the shell is updated only when the text changes');
  assert.equal(events.progress.filter((entry) => entry[0] === 'open').length, 1, 'one notification for the whole wait');
  // The holder stopped making progress: warned once; the user keeps waiting, then no new warning at once.
  answers.push('继续等待');
  presenter.onWait({ waitedMs: 30_000, activity: { ...migrating, heartbeatAgeMs: 20_000, stale: true } });
  await delay(10);
  presenter.onWait({ waitedMs: 31_000, activity: { ...migrating, heartbeatAgeMs: 21_000, stale: true } });
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
  early.onWait({ waitedMs: 1_000, activity: migrating });
  early.end();
  assert.deepEqual(announced, ['正在迁移数据目录，完成后自动打开；未发送的输入已保留。',
    '另一个窗口正在迁移数据目录（已进行 12 秒），完成后自动打开；未发送的输入已保留。', undefined]);
  assert.equal(events.progress.filter((entry) => entry[0] === 'open').length, 2, 'one notification per opening');

  // “关闭窗口” closes this window; nothing else happens.
  const closing = opening.createRuntimeOpeningWaitPresenter(() => {});
  answers.push('关闭窗口');
  closing.onWait({ waitedMs: 30_000, activity: { ...migrating, heartbeatAgeMs: 20_000, stale: true } });
  await delay(10);
  assert.deepEqual(events.commands, ['workbench.action.closeWindow']);
  closing.end();
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
    request: true, keptNoticeFile: path.join(path.dirname(fixture.root), 'kept-D.json'),
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
  assert.match(clicks.at(-1).reason, /本窗口是在那之后打开的/);
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
  assert.ok(statuses.some((text) => /^另一个窗口正在迁移数据目录（已进行 \d+ 秒），完成后自动打开；未发送的输入已保留。$/.test(text)), JSON.stringify(statuses));
  const released = windows.events().find((event) => event.name === 'R' && event.event === 'locks-released').at;
  assert.ok(reopened.at >= released, 'opened only after the maintenance let go of the locks');
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
  }, { countdownSeconds: 0, pollMs: 15, processId: (nextFakeProcessId += 1) });
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
        const { request: _request, explicit: _explicit, requestAfterMs: _after, ...rest } = behavior;
        void start(name, rest);
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
