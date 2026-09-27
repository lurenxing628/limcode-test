import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { after, test } from 'node:test';

const require = createRequire(import.meta.url);
const Module = require('node:module');
const originalLoad = Module._load;
Module._load = function load(name, parent, isMain) {
  return name === 'vscode'
    ? { EventEmitter: class { event = () => {}; }, Uri: { parse: (text) => ({ toString: () => text }) } }
    : originalLoad.call(this, name, parent, isMain);
};
after(() => { Module._load = originalLoad; });

const compiled = process.env.LIMCODE_TEST_EXTENSION_ROOT
  ? path.resolve(process.env.LIMCODE_TEST_EXTENSION_ROOT) : path.resolve('dist/extension');
const kernelFile = (file) => require(path.join(compiled, 'backend/reliableKernel', file));
const kernel = kernelFile('index.js');
const { RootAuthority } = kernelFile('rootAuthority.js');
const { resolveVscodeRuntimeDataRoot } = kernelFile('vscodeRootAuthority.js');
const { createCachedProcessClassifier, ownProcessStartIdentity } = kernelFile('runtimeClaimPrimitives.js');
const processProtocol = kernelFile('processProtocol.js');
const {
  isRuntimeDataRootAdmissionHeld, isRuntimeMaintenanceHeld, openUnderCurrentDataRootAdmission, RUNTIME_CLAIM_WAIT,
  runtimeDataRootAdmissionClaimPath, withRuntimeDataRootAdmission, withRuntimeMaintenance, withRuntimeMaintenanceActivity
} = kernelFile('runtimeHostControl.js');
const {
  clearExclusiveMaintenanceKey, readExclusiveMaintenanceRequests, registerExclusiveMaintenanceParticipant,
  requestExclusiveRuntimeMaintenance, runExclusiveRuntimeMaintenance, runtimeExclusiveMaintenanceDirectory,
  startExclusiveMaintenanceParticipant
} = kernelFile('runtimeExclusiveMaintenance.js');
const { VscodeReliableKernelApplicationFacade: Facade } = require(path.join(
  compiled, 'backend/application/reliableKernel/VscodeReliableKernelApplicationFacade.js'
));

const NOW = '2026-09-26T00:00:00.000Z';
// Long-running windows; a window that started moments ago gets a short grace to register.
const STARTED = '2026-01-01T00:00:00.000Z';
const BASE = { operation: 'historical-merge', operationKey: 'sources-a', message: '为合并旧聊天记录', ignoreBackoff: false };
const WORK = { kind: 'work', reason: '有任务正在进行' };
// Several simulated windows share this process: each gets its own identity for the self check.
let nextFakeProcessId = 3_000_000;

test('锁内轮次只能在 maintenance（及给定的 admission）内调用且不等待；等待只能在锁外；ignoreBackoff 必须显式传入', async (t) => {
  const { root, paths } = await createRoot(t);
  await assert.rejects(requestExclusiveRuntimeMaintenance(paths, BASE, async () => 1), /maintenance 锁内/);
  await assert.rejects(withRuntimeMaintenance(paths, () => requestExclusiveRuntimeMaintenance(
    paths, { ...BASE, configurationRootPath: root }, async () => 1
  )), /admission 内/);
  await assert.rejects(withRuntimeMaintenance(paths, () => requestExclusiveRuntimeMaintenance(
    paths, { ...BASE, whenBusy: 'wait' }, async () => 1
  )), /只能在锁外/);
  await assert.rejects(withRuntimeMaintenance(paths, () => runExclusiveRuntimeMaintenance(
    paths, { ...BASE, withLocks: (body) => body() }, async () => 1
  )), /之外进行/);
  const { ignoreBackoff: _omitted, ...implicit } = BASE;
  await assert.rejects(request(paths, implicit, async () => 1), /ignoreBackoff must be passed explicitly/);
  let waits = 0;
  const outcome = await request(paths, { ...BASE, onWaitStart: () => { waits += 1; } }, async () => 'done');
  assert.deepEqual(outcome, { state: 'completed', result: 'done', coordinated: false });
  assert.equal(waits, 0);
  assert.deepEqual(await readExclusiveMaintenanceRequests(paths), []);
  const nested = await withRuntimeDataRootAdmission(root, () => request(
    paths, { ...BASE, configurationRootPath: root }, async () => 'nested'
  ));
  assert.deepEqual(nested, { state: 'completed', result: 'nested', coordinated: false });
  const outside = await run(paths, { ...BASE, configurationRootPath: root, withLocks: (body) =>
    withRuntimeDataRootAdmission(root, () => withRuntimeMaintenance(paths, body)) }, async () =>
    isRuntimeMaintenanceHeld(paths) && isRuntimeDataRootAdmissionHeld(root));
  assert.deepEqual(outside, { state: 'completed', result: true, coordinated: false }, 'the operation runs under the locks');
});

test('有未参与协作（旧版本）或状态无法确认的窗口时立即放弃，不发布请求，同一操作键随后退避', async (t) => {
  const { binding, paths } = await createRoot(t);
  await publishHost(binding, 'old-window');
  let ran = false;
  const operation = async () => { ran = true; };
  const first = await request(paths, BASE, operation);
  assert.equal(first.state, 'legacy-host');
  assert.deepEqual(first.hosts.map((host) => host.hostBootId), ['old-window']);
  assert.match(first.reason, /未参与协作的窗口（可能是旧版本）/);
  assert.deepEqual(await readExclusiveMaintenanceRequests(paths), []);

  const second = await request(paths, BASE, operation);
  assert.equal(second.state, 'backoff');
  assert.ok(Date.parse(second.retryAfter) > Date.now());
  assert.equal((await request(paths, { ...BASE, operationKey: 'sources-b' }, operation)).state, 'legacy-host',
    'a different work is not delayed by this key');
  assert.equal((await request(paths, { ...BASE, ignoreBackoff: true }, operation)).state, 'legacy-host',
    'an explicit user request skips the key backoff');

  await fs.writeFile(path.join(paths.dataRootPath, 'host-liveness', 'broken.json'), '{');
  const unknown = await request(paths, { ...BASE, operationKey: 'sources-c' }, operation);
  assert.equal(unknown.state, 'legacy-host');
  assert.match(unknown.reason, /运行状态无法确认/);
  assert.equal(ran, false);
});

test('刚启动、尚未登记的窗口的宽限与准备阶段超时一致：及时登记就正常回应，否则在超时内放弃', async (t) => {
  const { binding, paths } = await createRoot(t);
  const opening = openWindow(t, binding, 'just-opened', { startedAt: new Date().toISOString(), registerAfterMs: 150 });
  // The request is issued while the window's Runtime is open but its participant not started yet.
  await delay(50);
  const outcome = await request(paths, BASE, async () => 'done');
  const window = await opening;
  assert.deepEqual(outcome, { state: 'completed', result: 'done', coordinated: true });
  assert.equal(window.releases(), 1);

  const { binding: other, paths: otherPaths } = await createRoot(t);
  await publishHost(other, 'never-registers', new Date().toISOString());
  const started = performance.now();
  const late = await request(otherPaths, { ...BASE, prepareTimeoutMs: 300 }, async () => assert.fail('must not run'));
  // Before: a 15 s grace the 8 s prepare timeout cut short, reported as a timeout.
  assert.equal(late.state, 'legacy-host');
  assert.ok(performance.now() - started < 2_000, 'no longer than the prepare timeout plus a poll');
});

test('全部空闲时分三阶段：所有窗口确认之后才统一让出，全部下线后才执行并清理请求', async (t) => {
  const { binding, paths } = await createRoot(t);
  const log = [];
  const a = await openWindow(t, binding, 'window-a', { log });
  const b = await openWindow(t, binding, 'window-b', { log });
  const outcome = await request(paths, {
    ...BASE,
    onWaitStart: (hosts) => log.push(['wait-start', hosts.map((host) => host.hostBootId).sort()]),
    onWaitEnd: () => log.push(['wait-end'])
  }, async () => {
    log.push(['operation']);
    // Still published while it runs: a reloaded window's next startup waits on the admission.
    assert.deepEqual((await readExclusiveMaintenanceRequests(paths)).map((request) => request.phase), ['go']);
    return 42;
  });
  assert.deepEqual(outcome, { state: 'completed', result: 42, coordinated: true });
  assert.deepEqual(log[0], ['wait-start', ['window-a', 'window-b']]);
  const lastConfirm = Math.max(...['window-a', 'window-b'].map((name) => log.findLastIndex((entry) => entry[0] === 'confirm' && entry[1] === name)));
  const firstRelease = log.findIndex((entry) => entry[0] === 'release');
  assert.ok(lastConfirm >= 0 && firstRelease > lastConfirm, `every window confirms before any yields: ${JSON.stringify(log)}`);
  assert.deepEqual(log.slice(-2), [['wait-end'], ['operation']]);
  assert.deepEqual([a.releases(), b.releases()], [1, 1]);
  const directory = runtimeExclusiveMaintenanceDirectory(paths);
  assert.deepEqual(await fs.readdir(path.join(directory, 'requests')), []);
  assert.deepEqual(await fs.readdir(path.join(directory, 'responses')), []);
});

test('有窗口在忙时立即放弃：没有任何窗口倒计时或重载，同一操作键随后退避', async (t) => {
  const { binding, paths } = await createRoot(t);
  const idle = await openWindow(t, binding, 'idle-window');
  const busy = await openWindow(t, binding, 'busy-window', { busy: WORK });
  let ran = false;
  const outcome = await request(paths, BASE, async () => { ran = true; });
  assert.equal(outcome.state, 'busy');
  assert.deepEqual(outcome.hosts.map((host) => host.hostBootId), ['busy-window']);
  assert.match(outcome.reason, /1 个其它窗口有任务正在进行/);
  await settle([idle, busy]);
  assert.deepEqual([idle.confirms(), idle.releases(), busy.confirms(), busy.releases()], [0, 0, 0, 0]);
  assert.equal(ran, false);
  assert.equal((await request(paths, BASE, async () => { ran = true; })).state, 'backoff');
  assert.equal(ran, false);
});

test('确认阶段有窗口的用户选择保留：放弃，且没有任何窗口重载', async (t) => {
  const { binding, paths } = await createRoot(t);
  const keep = await openWindow(t, binding, 'keep-window', { confirm: false });
  const other = await openWindow(t, binding, 'other-window');
  const outcome = await request(paths, BASE, async () => assert.fail('must not run'));
  assert.equal(outcome.state, 'declined');
  assert.deepEqual(outcome.hosts.map((host) => host.hostBootId), ['keep-window']);
  await settle([keep, other]);
  assert.equal(keep.confirms(), 1);
  assert.deepEqual([keep.releases(), other.releases()], [0, 0]);
});

test('wait 模式只在锁外等待：等忙窗口空闲后再协调，按原因提示它一次；等待有上限', async (t) => {
  const { binding, paths } = await createRoot(t);
  const idle = await openWindow(t, binding, 'idle-window');
  const busy = await openWindow(t, binding, 'busy-window', { busy: WORK });
  const focused = await openWindow(t, binding, 'focused-window', { busy: { kind: 'focus', reason: '窗口正在使用' } });
  setTimeout(() => busy.setBusy(undefined), 200);
  setTimeout(() => focused.setBusy(undefined), 300);
  const progress = [];
  const outcome = await run(paths, {
    ...BASE, operation: 'data-root-migration', operationKey: 'target-1', message: '为迁移数据目录', ignoreBackoff: true,
    whenBusy: 'wait', participantConfirmation: 'final-countdown', busyWaitTimeoutMs: 5_000,
    onProgress: (item) => progress.push(item)
  }, async () => 'migrated');
  assert.deepEqual(outcome, { state: 'completed', result: 'migrated', coordinated: true });
  const waiting = progress.filter((item) => item.stage === 'waiting-busy');
  assert.ok(waiting.some((item) => item.busy.some((entry) => entry.kind === 'work'))
    && waiting.some((item) => item.busy.some((entry) => entry.kind === 'focus')), 'both kinds are reported apart');
  assert.deepEqual(busy.log.filter((entry) => entry[0] === 'waiting'), [['waiting', 'busy-window', 'work']]);
  assert.deepEqual(focused.log.filter((entry) => entry[0] === 'waiting'), [['waiting', 'focused-window', 'focus']]);
  assert.deepEqual([idle.releases(), busy.releases(), focused.releases()], [1, 1, 1]);

  const { binding: other, paths: otherPaths } = await createRoot(t);
  const stuck = await openWindow(t, other, 'stuck-window', { busy: WORK });
  const started = performance.now();
  const bounded = await run(otherPaths, { ...BASE, whenBusy: 'wait', busyWaitTimeoutMs: 200 }, async () => assert.fail('must not run'));
  assert.equal(bounded.state, 'busy');
  assert.ok(performance.now() - started < 3_000);
  await settle([stuck]);
  assert.equal(stuck.releases(), 0);
});

test('锁外等待期间其它窗口可以正常打开（拿到 admission 与 maintenance），新窗口随后也参与协调', async (t) => {
  const { root, binding, paths } = await createRoot(t);
  const busy = await openWindow(t, binding, 'busy-window', { busy: WORK });
  const withLocks = (body) => withRuntimeDataRootAdmission(root, () => withRuntimeMaintenance(paths, body));
  const waiting = run(paths, {
    ...BASE, configurationRootPath: root, whenBusy: 'wait', busyWaitTimeoutMs: 10_000, withLocks
  }, async () => 'done');
  await delay(150);
  // A window starting now: its Runtime open takes the admission and the maintenance claim.
  const started = performance.now();
  await withRuntimeDataRootAdmission(root, () => withRuntimeMaintenance(paths, async () => undefined));
  const openedWithin = performance.now() - started;
  assert.ok(openedWithin < 1_000, `opened after ${openedWithin} ms`);
  const late = await openWindow(t, binding, 'late-window', { startedAt: new Date().toISOString() });
  await delay(100);
  busy.setBusy(undefined);
  assert.deepEqual(await waiting, { state: 'completed', result: 'done', coordinated: true });
  assert.deepEqual([busy.releases(), late.releases()], [1, 1]);
});

test('锁内轮次的持锁时间有上限：有窗口一直不确认时在确认超时后放弃并释放锁', async (t) => {
  const { binding, paths } = await createRoot(t);
  await openWindow(t, binding, 'silent-confirm', { confirm: () => new Promise(() => {}) });
  let lockedFor;
  const outcome = await run(paths, {
    ...BASE, prepareTimeoutMs: 300, confirmTimeoutMs: 300, releaseTimeoutMs: 300,
    withLocks: async (body) => {
      const started = performance.now();
      try { return await withRuntimeMaintenance(paths, body); }
      finally { lockedFor = performance.now() - started; }
    }
  }, async () => assert.fail('must not run'));
  assert.equal(outcome.state, 'timed-out');
  assert.ok(lockedFor < 300 + 300 + 300 + 500, `held ${lockedFor} ms`);
  assert.equal(isRuntimeMaintenanceHeld(paths), false);
});

test('wait 模式下确认后又开始工作的窗口不会被打断：放开锁回到锁外等待，之后新一轮完成', async (t) => {
  const { binding, paths } = await createRoot(t);
  const steady = await openWindow(t, binding, 'steady-window');
  let startedWorkIn;
  const flaky = await openWindow(t, binding, 'flaky-window', {
    confirm: (request) => {
      if (startedWorkIn === undefined) {
        // The user started a Turn while the countdown ran.
        startedWorkIn = request.round;
        flaky.setBusy(WORK);
        setTimeout(() => flaky.setBusy(undefined), 150);
      }
      return true;
    }
  });
  let lockedRounds = 0;
  const outcome = await run(paths, {
    ...BASE, whenBusy: 'wait', busyWaitTimeoutMs: 5_000,
    withLocks: (body) => { lockedRounds += 1; return withRuntimeMaintenance(paths, body); }
  }, async () => 'done');
  assert.deepEqual(outcome, { state: 'completed', result: 'done', coordinated: true });
  assert.equal(lockedRounds, 2, 'the locks were released in between');
  const releases = [...flaky.log, ...steady.log].filter((entry) => entry[0] === 'release').map((entry) => entry[2]);
  assert.equal(releases.length, 2);
  assert.ok(releases.every((round) => round > startedWorkIn), JSON.stringify({ releases, startedWorkIn }));
});

test('锁内反复遇到新开始的工作时有次数上限，之后放弃', async (t) => {
  const { binding, paths } = await createRoot(t);
  // Idle whenever asked outside the locks, busy again in every locked round.
  const window = await openWindow(t, binding, 'restless-window', {
    busy: (request) => request.round % 2 === 0 ? WORK : undefined
  });
  let lockedRounds = 0;
  const outcome = await run(paths, {
    ...BASE, whenBusy: 'wait', busyWaitTimeoutMs: 5_000, maxLockedAttempts: 2,
    withLocks: (body) => { lockedRounds += 1; return withRuntimeMaintenance(paths, body); }
  }, async () => assert.fail('must not run'));
  assert.equal(outcome.state, 'busy');
  assert.equal(outcome.reason, '准备期间反复有窗口变忙（最后一次：1 个其它窗口有任务正在进行），这次没有进行，稍后再试。');
  assert.equal(lockedRounds, 2);
  assert.equal(window.releases(), 0);
});

test('go 阶段回答忙的窗口本轮不再重载（即使随后变空闲）；已让出的窗口白白重载一次，这次调用结束，操作不执行', async (t) => {
  const { binding, paths } = await createRoot(t);
  const fast = await openWindow(t, binding, 'fast-window');
  let answeredGoBusy = false;
  const slow = await openWindow(t, binding, 'slow-window', {
    // The user clicks into this window after it confirmed and after the fast one reloaded (the order
    // is fixed: the busy answer waits for that reload), right before it saw go; then leaves.
    busy: async (request) => {
      if (request.phase !== 'go' || answeredGoBusy) return undefined;
      answeredGoBusy = true;
      await fast.released;
      // Idle again at once: every later poll of this round must still not reload it.
      setImmediate(() => { void slow.check(); });
      return { kind: 'focus', reason: '窗口正在使用' };
    }
  });
  let ran = false;
  let lockedRounds = 0;
  // The requester reads the busy answer only on its next poll; meanwhile the window is idle again.
  const outcome = await run(paths, {
    ...BASE, whenBusy: 'wait', busyWaitTimeoutMs: 5_000, pollMs: 300,
    withLocks: (body) => { lockedRounds += 1; return withRuntimeMaintenance(paths, body); }
  }, async () => { ran = true; });
  assert.equal(outcome.state, 'busy', 'a busy window at go ends the call, even in wait mode');
  assert.match(outcome.reason, /其它窗口开始让出后1 个其它窗口正在使用，这次没有进行/);
  assert.equal(ran, false);
  assert.equal(lockedRounds, 1, 'no second round in the same call');
  await settle([slow, fast]);
  await slow.check();
  assert.equal(slow.releases(), 0, 'a window that answered busy at go never yields in that round');
  assert.equal(fast.releases(), 1, 'the documented cost of a go-stage abandon: one reload in vain, never two');
  // The cooldown holds off an automatic retry of the operation.
  const again = await run(paths, { ...BASE, operationKey: 'sources-b' }, async () => assert.fail('must not run'));
  assert.equal(again.state, 'backoff');
});

test('go 阶段遇忙的调用在慢窗口看到 go 之前就结束时，慢窗口不重载', async (t) => {
  const { binding, paths } = await createRoot(t);
  // This window checks for requests only when the test says so (a window busy with other things).
  const late = await openWindow(t, binding, 'late-window', { pollMs: 60 * 60_000 });
  const busyAtGo = await openWindow(t, binding, 'busy-at-go', { busy: async (request) => request.phase === 'go' ? WORK : undefined });
  const confirmedBoth = run(paths, { ...BASE, confirmTimeoutMs: 5_000 }, async () => assert.fail('must not run'));
  // late answers prepare and confirm when asked, and is not asked again once it confirmed.
  while (late.confirms() === 0) {
    await late.check();
    await delay(10);
  }
  const outcome = await confirmedBoth;
  assert.equal(outcome.state, 'busy');
  await late.check();
  assert.deepEqual([late.releases(), busyAtGo.releases()], [0, 0], 'the call ended before late saw go');
});

test('go 之后操作失败按操作键退避；冷却按操作挡住自动调用与不带发起方标识的明确调用（换键、换目标都绕不开），写明何时可以再试；发起窗口重载后凭标识越过，换目标也可以', async (t) => {
  const { binding, paths } = await createRoot(t);
  const failure = () => Object.assign(new Error('复制正文文件时出错'), { code: 'EIO' });
  // Like the data-directory commands: the key carries the attempt's own id.
  const input = { ...BASE, operation: 'data-root-migration', message: '为迁移数据目录', backoffBaseMs: 60_000 };
  const attempt = (target, id) => ({ ...input, operationKey: `to:${target}#${id}` });
  await openWindow(t, binding, 'peer-1');
  // The user's migration: the window that asks carries the token of this operation.
  await assert.rejects(request(paths, { ...attempt('/target-1', 'a1'), ignoreBackoff: true, requesterToken: 'operation-1' }, async () => { throw failure(); }),
    /复制正文文件时出错/);
  await openWindow(t, binding, 'peer-2');
  const automatic = await request(paths, attempt('/target-1', 'a2'), async () => assert.fail('must not run'));
  assert.equal(automatic.state, 'backoff', 'automatic calls wait for the cooldown whatever their key');
  // Another window (it just yielded, no token) asks explicitly, with a new attempt id: refused, with when.
  const other = await request(paths, { ...attempt('/target-1', 'a3'), ignoreBackoff: true }, async () => assert.fail('must not run'));
  assert.equal(other.state, 'backoff');
  assert.match(other.reason, /^刚刚已经为这项维护让其它窗口重载过一次，暂不再次要求其它窗口重载。约 10 分钟后（\d\d:\d\d 以后）可以再试。$/);
  assert.ok(Date.parse(other.retryAfter) - Date.now() > 9 * 60_000);
  assert.equal((await request(paths, { ...attempt('/target-2', 'a4'), ignoreBackoff: true }, async () => assert.fail('must not run'))).state,
    'backoff', 'another target does not get another window past the cooldown either');
  assert.equal((await request(paths, { ...attempt('/target-1', 'a5'), ignoreBackoff: true, requesterToken: 'another-operation' }, async () => assert.fail('must not run'))).state,
    'backoff', 'a token of another operation does not help');
  assert.equal((await request(paths, { ...attempt('/target-1', 'a6'), requesterToken: 'operation-1' }, async () => assert.fail('must not run'))).state,
    'backoff', 'an automatic call never passes, token or not');
  const ledger = path.join(runtimeExclusiveMaintenanceDirectory(paths), 'ledger');
  const keyEntry = async (key) => {
    for (const name of await fs.readdir(ledger)) {
      const entry = JSON.parse(await fs.readFile(path.join(ledger, name), 'utf8'));
      if (entry.scope === 'key' && entry.operationKey === key) return entry;
    }
    return undefined;
  };
  assert.equal((await keyEntry('to:/target-1#a1')).attempts, 1);
  // The window that asked reloaded after the failure; the user retries right away (a new attempt, same token).
  assert.deepEqual(await request(paths, { ...attempt('/target-1', 'a7'), ignoreBackoff: true, requesterToken: 'operation-1' }, async () => 'migrated'),
    { state: 'completed', result: 'migrated', coordinated: true });
  // That go started the cooldown again: still only the window that asked gets past it, also for another target.
  await openWindow(t, binding, 'peer-3');
  assert.equal((await request(paths, { ...attempt('/target-2', 'a8'), ignoreBackoff: true }, async () => assert.fail('must not run'))).state, 'backoff');
  assert.deepEqual(await request(paths, { ...attempt('/target-2', 'a9'), ignoreBackoff: true, requesterToken: 'operation-1' }, async () => 'elsewhere'),
    { state: 'completed', result: 'elsewhere', coordinated: true });
  // Same key again: success resets that key's backoff.
  await openWindow(t, binding, 'peer-4');
  await assert.rejects(request(paths, { ...attempt('/target-3', 'b1'), ignoreBackoff: true, requesterToken: 'operation-1' }, async () => { throw failure(); }));
  assert.equal((await keyEntry('to:/target-3#b1')).attempts, 1);
  await openWindow(t, binding, 'peer-5');
  assert.deepEqual(await request(paths, { ...attempt('/target-3', 'b1'), ignoreBackoff: true, requesterToken: 'operation-1' }, async () => 'again'),
    { state: 'completed', result: 'again', coordinated: true });
  assert.equal(await keyEntry('to:/target-3#b1'), undefined, 'success resets the backoff');
});

test('确定性失败只拦自动调用：用户明确重试照常执行，成功后清除；也可以显式清除', async (t) => {
  const { paths } = await createRoot(t);
  const deterministic = { ...BASE, operationKey: 'to:/target', isDeterministicFailure: (error) => error.code === 'EACCES' };
  // Alone: the operation runs at once and fails (the target directory is not writable).
  await assert.rejects(request(paths, deterministic, async () => {
    throw Object.assign(new Error('目标目录不可写'), { code: 'EACCES' });
  }), /目标目录不可写/);
  const automatic = await request(paths, deterministic, async () => assert.fail('must not run'));
  assert.equal(automatic.state, 'blocked');
  assert.match(automatic.reason, /目标目录不可写；排除原因后可以手动再试/);
  // The user fixed the permission and explicitly tries again.
  assert.deepEqual(await request(paths, { ...deterministic, ignoreBackoff: true }, async () => 'migrated'),
    { state: 'completed', result: 'migrated', coordinated: false });
  assert.deepEqual(await request(paths, deterministic, async () => 'again'), { state: 'completed', result: 'again', coordinated: false },
    'success cleared the blocked key');

  await assert.rejects(request(paths, deterministic, async () => { throw Object.assign(new Error('还是不可写'), { code: 'EACCES' }); }));
  assert.equal((await request(paths, deterministic, async () => assert.fail('must not run'))).state, 'blocked');
  await clearExclusiveMaintenanceKey(paths, deterministic.operation, deterministic.operationKey);
  assert.equal((await request(paths, deterministic, async () => 'cleared')).state, 'completed');
});

test('发起方自己窗口的忙也要等：锁外等待它空闲；abandon 模式直接放弃', async (t) => {
  const { binding, paths } = await createRoot(t);
  const peer = await openWindow(t, binding, 'peer-window');
  let ownBusy = true;
  setTimeout(() => { ownBusy = false; }, 200);
  const progress = [];
  const outcome = await run(paths, {
    ...BASE, operation: 'data-root-migration', operationKey: 'target-1', ignoreBackoff: true, whenBusy: 'wait',
    requesterHostBootId: 'self-window', requesterBusy: async () => ownBusy ? { kind: 'work', reason: '本窗口有任务正在进行' } : undefined,
    onProgress: (item) => progress.push(item)
  }, async () => 'migrated');
  assert.deepEqual(outcome, { state: 'completed', result: 'migrated', coordinated: true });
  assert.ok(progress.some((item) => item.stage === 'waiting-busy' && item.requesterBusy?.kind === 'work'));
  assert.equal(peer.releases(), 1);

  const { paths: alonePaths } = await createRoot(t);
  const alone = await request(alonePaths, {
    ...BASE, requesterBusy: async () => ({ kind: 'work', reason: '本窗口有任务正在进行' })
  }, async () => assert.fail('must not run'));
  assert.equal(alone.state, 'busy');
  assert.match(alone.reason, /本窗口还有任务正在进行/);
});

test('发起方自己的窗口按 requesterHostBootId（或同一进程）跳过请求，不会被要求重载', async (t) => {
  const { binding, paths } = await createRoot(t);
  const self = await openWindow(t, binding, 'self-window');
  const peer = await openWindow(t, binding, 'peer-window');
  const outcome = await request(paths, {
    ...BASE, operation: 'data-root-migration', operationKey: 'target-1', message: '为迁移数据目录',
    requesterHostBootId: 'self-window', participantConfirmation: 'notice'
  }, async () => 'migrated');
  assert.deepEqual(outcome, { state: 'completed', result: 'migrated', coordinated: true });
  assert.deepEqual(self.log, []);
  assert.equal(peer.releases(), 1);

  // Without a Host id the requester's process identifies it.
  const { binding: other, paths: otherPaths } = await createRoot(t);
  const sameProcess = await openWindow(t, other, 'same-process-window', { processId: process.pid });
  const skipped = await request(otherPaths, { ...BASE, prepareTimeoutMs: 200 }, async () => assert.fail('must not run'));
  assert.equal(skipped.state, 'timed-out');
  assert.deepEqual(sameProcess.log, []);
});

test('参与方没有及时回应时按上限超时放弃；发起方取消时不计入退避', async (t) => {
  const { binding, paths } = await createRoot(t);
  await publishHost(binding, 'silent-window');
  const registration = await registerExclusiveMaintenanceParticipant(paths, 'silent-window');
  t.after(() => registration.unregister());
  const started = performance.now();
  const outcome = await request(paths, { ...BASE, prepareTimeoutMs: 150 }, async () => assert.fail('must not run'));
  assert.equal(outcome.state, 'timed-out');
  assert.deepEqual(outcome.hosts.map((host) => host.hostBootId), ['silent-window']);
  assert.ok(performance.now() - started < 2_000);
  assert.deepEqual(await readExclusiveMaintenanceRequests(paths), []);

  let cancel = false;
  setTimeout(() => { cancel = true; }, 50);
  const cancelled = await request(paths, { ...BASE, operationKey: 'sources-b', isCancelled: () => cancel }, async () => assert.fail('must not run'));
  assert.equal(cancelled.state, 'cancelled');
  const again = await request(paths, { ...BASE, operationKey: 'sources-b', prepareTimeoutMs: 50 }, async () => assert.fail('must not run'));
  assert.equal(again.state, 'timed-out', 'a cancel does not delay the next attempt');
});

test('一次协调让其它窗口重载后同一操作进入冷却：刚让出的窗口不能马上反过来要求别人让出', async (t) => {
  const { binding, paths } = await createRoot(t);
  const a = await openWindow(t, binding, 'window-a');
  // B starts (not yet registered) and asks A to yield once.
  const first = await request(paths, BASE, async () => 'merged-by-b');
  assert.deepEqual(first, { state: 'completed', result: 'merged-by-b', coordinated: true });
  assert.equal(a.releases(), 1);
  // B opened; A restarts and would ask B for the same operation (even another key, even explicitly): cooldown.
  const b = await openWindow(t, binding, 'window-b');
  const automatic = await request(paths, { ...BASE, operationKey: 'sources-b' }, async () => assert.fail('must not run'));
  assert.equal(automatic.state, 'backoff');
  assert.match(automatic.reason, /^刚刚已经为这项维护让其它窗口重载过一次，暂不再次要求其它窗口重载。约 10 分钟后/);
  // Explicitly, from the window that just yielded (no token of that operation), for any work: still not.
  for (const key of [BASE.operationKey, 'sources-b']) {
    const explicit = await request(paths, { ...BASE, operationKey: key, ignoreBackoff: true }, async () => assert.fail('must not run'));
    assert.equal(explicit.state, 'backoff');
    assert.match(explicit.reason, /暂不再次要求其它窗口重载。约 \d+ 分钟后（\d\d:\d\d 以后）可以再试。$/);
  }
  await settle([b]);
  assert.equal(b.confirms(), 0);
});

test('清理失败不会覆盖已完成的结果；EPERM 等临时错误会重试；撤回失败的请求不会让参与方再倒计时', async (t) => {
  const { binding, paths } = await createRoot(t);
  const requests = path.join(runtimeExclusiveMaintenanceDirectory(paths), 'requests');
  const fsPromises = require('node:fs/promises');
  const originalRm = fsPromises.rm;
  let transient = 0;
  fsPromises.rm = async (target, options) => {
    if (path.dirname(String(target)) === requests && String(target).endsWith('.json') && transient < 2) {
      transient += 1;
      throw Object.assign(new Error('operation not permitted'), { code: 'EPERM' });
    }
    return originalRm(target, options);
  };
  t.after(() => { fsPromises.rm = originalRm; });
  await openWindow(t, binding, 'window-a');
  assert.deepEqual(await request(paths, { ...BASE, cooldownAfterCoordinatedMs: 1 }, async () => 'first'),
    { state: 'completed', result: 'first', coordinated: true });
  assert.equal(transient, 2);
  assert.deepEqual(await fs.readdir(requests), [], 'removed after retrying');
  fsPromises.rm = originalRm;

  if (process.platform === 'win32' || process.getuid?.() === 0) return;
  // The request cannot be removed; it was marked withdrawn first, so no window counts down again.
  let blockRemoval = false;
  const keep = await openWindow(t, binding, 'window-keep', { confirm: () => { blockRemoval = true; return false; } });
  const bystander = await openWindow(t, binding, 'window-bystander');
  const warnings = [];
  const originalWarn = console.warn;
  console.warn = (...args) => warnings.push(String(args[0]));
  t.after(() => { console.warn = originalWarn; });
  fsPromises.rm = async (target, options) => {
    if (blockRemoval && path.dirname(String(target)) === requests) throw Object.assign(new Error('permission denied'), { code: 'EACCES' });
    return originalRm(target, options);
  };
  const outcome = await request(paths, { ...BASE, operationKey: 'sources-b' }, async () => assert.fail('must not run'));
  fsPromises.rm = originalRm;
  console.warn = originalWarn;
  assert.equal(outcome.state, 'declined');
  assert.ok(warnings.some((warning) => /无法撤回独占维护请求/.test(warning)), JSON.stringify(warnings));
  assert.equal((await fs.readdir(requests)).length, 1, 'the request file is still there');
  assert.deepEqual(await readExclusiveMaintenanceRequests(paths), [], 'but it is withdrawn');
  const confirms = bystander.confirms();
  await settle([bystander, keep]);
  assert.equal(bystander.confirms(), confirms);
  assert.equal(bystander.releases(), 0);
});

test('轮询期间每个进程只做一次平台身份探测；登记参与方时不做平台身份探测', async (t) => {
  const { binding, paths } = await createRoot(t);
  for (const name of ['peer-1', 'peer-2']) {
    await publishHost(binding, name);
    const registration = await registerExclusiveMaintenanceParticipant(paths, name);
    t.after(() => registration.unregister());
  }
  const original = processProtocol.readProcessStartFingerprint;
  let probes = 0;
  processProtocol.readProcessStartFingerprint = (pid) => { probes += 1; return original(pid); };
  t.after(() => { processProtocol.readProcessStartFingerprint = original; });
  const outcome = await request(paths, { ...BASE, pollMs: 250, prepareTimeoutMs: 1_000 }, async () => undefined);
  assert.equal(outcome.state, 'timed-out');
  // Before: every poll re-probed every Host (about 5 polls x 2 Hosts within this second).
  assert.ok(probes <= 1, `probes=${probes}`);

  probes = 0;
  const registration = await registerExclusiveMaintenanceParticipant(paths, 'peer-3');
  await registration.unregister();
  processProtocol.readProcessStartFingerprint = original;
  assert.equal(probes, 0, 'existing registrations are checked with kill(pid, 0) only');

  let calls = 0;
  const child = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 30000)'], { stdio: 'ignore' });
  t.after(() => child.kill('SIGKILL'));
  const classify = createCachedProcessClassifier(() => { calls += 1; return 'alive'; });
  assert.equal(classify(child.pid, 'identity'), 'alive');
  assert.equal(classify(child.pid, 'identity'), 'alive');
  assert.equal(calls, 1);
  const exited = new Promise((resolve) => child.once('exit', resolve));
  child.kill('SIGKILL');
  await exited;
  assert.equal(classify(child.pid, 'identity'), 'dead');
  assert.equal(calls, 1);
});

test('过期、撤回、心跳过期或请求方已不存在的请求不会被理会；崩溃发起方的残留由下一次请求清理', async (t) => {
  const { binding, paths } = await createRoot(t);
  const directory = runtimeExclusiveMaintenanceDirectory(paths);
  await fs.mkdir(path.join(directory, 'requests'), { recursive: true });
  const valid = {
    kind: 'limcode-runtime-exclusive-maintenance-request', requestId: 'request-1', round: 1, phase: 'confirm',
    operation: 'historical-merge', operationKey: 'sources-a', message: '为合并旧聊天记录', activity: '合并旧聊天记录', confirmation: 'countdown',
    whenBusy: 'abandon', requesterProcessId: process.pid, requesterProcessStartIdentity: ownProcessStartIdentity(),
    createdAt: NOW, heartbeatAt: new Date().toISOString(), expiresAt: new Date(Date.now() + 60_000).toISOString()
  };
  const write = (value) => fs.writeFile(path.join(directory, 'requests', 'request-1.json'), JSON.stringify(value));
  const ids = async () => (await readExclusiveMaintenanceRequests(paths)).map((request) => request.requestId);
  await write(valid);
  assert.deepEqual(await ids(), ['request-1']);
  await write({ ...valid, expiresAt: NOW });
  assert.deepEqual(await ids(), []);
  await write({ ...valid, phase: 'withdrawn' });
  assert.deepEqual(await ids(), [], 'withdrawn but not removable');
  await write({ ...valid, heartbeatAt: new Date(Date.now() - 60_000).toISOString() });
  assert.deepEqual(await ids(), [], 'a requester that stopped refreshing it');
  const { heartbeatAt: _heartbeat, ...older } = valid;
  await write(older);
  assert.deepEqual(await ids(), [], 'an older request format is not trusted');
  const { activity: _activity, ...withoutActivity } = valid;
  await write(withoutActivity);
  assert.deepEqual(await ids(), [], 'nor one without the activity');
  const deadProcessId = await exitedProcessId();
  await write({ ...valid, requesterProcessId: deadProcessId, requesterProcessStartIdentity: undefined });
  assert.deepEqual(await ids(), []);
  // A participant never counts down for any of these.
  const window = await openWindow(t, binding, 'window-a');
  await settle([window]);
  assert.equal(window.confirms(), 0);

  // The crashed requester's leftovers are swept when the next request starts.
  await fs.mkdir(path.join(directory, 'responses', 'request-1'), { recursive: true });
  await fs.writeFile(path.join(directory, 'responses', 'request-1', 'window-a.json'), '{}');
  const longAgo = new Date(Date.now() - 60_000);
  await fs.utimes(path.join(directory, 'responses', 'request-1'), longAgo, longAgo);
  // Answers written just now may belong to a request published while the cleanup ran: kept for now.
  await fs.mkdir(path.join(directory, 'responses', 'just-answered'), { recursive: true });
  await request(paths, BASE, async () => 'done');
  assert.deepEqual(await fs.readdir(path.join(directory, 'requests')), []);
  assert.deepEqual(await fs.readdir(path.join(directory, 'responses')), ['just-answered']);

  if (ownProcessStartIdentity() !== undefined) {
    await fs.writeFile(path.join(directory, 'hosts', 'stale-window.json'), JSON.stringify({
      kind: 'limcode-runtime-exclusive-maintenance-participant', hostBootId: 'stale-window',
      processId: deadProcessId, registeredAt: NOW
    }));
    const participant = await registerExclusiveMaintenanceParticipant(paths, 'fresh-window');
    assert.equal((await fs.readdir(path.join(directory, 'hosts'))).includes('stale-window.json'), false);
    await participant.unregister();
  }
  await assert.rejects(registerExclusiveMaintenanceParticipant(paths, '../escape'), /safe file name/);
});

test('打开运行时时若数据目录在等待 admission 期间已迁移，放开旧根并在新根的 admission 内打开', async (t) => {
  const parent = await fs.mkdtemp(path.join(os.tmpdir(), 'limcode-admission-follow-'));
  t.after(() => fs.rm(parent, { recursive: true, force: true }));
  const oldRoot = path.join(parent, 'old');
  const newRoot = path.join(parent, 'new');
  let current = oldRoot;
  let held;
  const migrationHeld = new Promise((resolve) => { held = resolve; });
  let finish;
  const migrationGate = new Promise((resolve) => { finish = resolve; });
  // The migration holds the old root's admission, publishes the new root, then releases.
  const migration = withRuntimeDataRootAdmission(oldRoot, async () => {
    held();
    await migrationGate;
    current = newRoot;
  });
  await migrationHeld;
  let opens = 0;
  const opening = openUnderCurrentDataRootAdmission(async () => current, async () => {
    opens += 1;
    return { root: current, oldHeld: isRuntimeDataRootAdmissionHeld(oldRoot), newHeld: isRuntimeDataRootAdmissionHeld(newRoot) };
  });
  await delay(100);
  assert.equal(opens, 0, 'waits on the admission');
  finish();
  await migration;
  assert.deepEqual(await opening, { root: newRoot, oldHeld: false, newHeld: true });
  assert.equal(opens, 1);

  let flips = 0;
  await assert.rejects(openUnderCurrentDataRootAdmission(
    async () => ((flips += 1) % 2 ? oldRoot : newRoot),
    async () => assert.fail('must not open'),
    3
  ), /数据目录在打开期间反复变化/);
});

test('窗口是否空闲复用对话的待办工作判定：执行中的命令和已排队的工作都算忙', async (t) => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'limcode-owned-execution-'));
  const root = await kernel.resetCandidateRuntimeRoot(directory);
  const database = await kernel.RuntimeDatabase.open(root.authority, { hostBootId: 'owned-execution-host' });
  t.after(async () => {
    await database.close();
    await fs.rm(directory, { recursive: true, force: true });
  });
  const facade = { requireOpen() {}, product: { application: { database } } };
  const busy = () => Facade.prototype.hasOwnedExecution.call(facade);
  assert.equal(await busy(), false);
  await database.conversationOwners.claim('conversation_idle');
  assert.equal(await busy(), false, 'owning an idle conversation keeps nothing running');
  let inside;
  await database.conversationOwners.run('conversation_idle', async () => { inside = await busy(); });
  assert.equal(inside, true, 'a command in progress (activity pin) is busy');
  const row = (domain, value) => kernel.DOMAIN_REPOSITORIES.domain(domain).insert(value);
  await database.transaction([
    row('Conversation', { id: 'conversation_running', title: 'running', status: 'active', created_at: NOW, updated_at: NOW }),
    row('Turn', { id: 'turn_running', conversation_id: 'conversation_running', status: 'active', created_at: NOW, updated_at: NOW })
  ]);
  await database.conversationOwners.claim('conversation_running');
  assert.equal(await busy(), true, 'durable pending work of an owned conversation is busy');
});

test('两个请求方不互等：本窗口有进行中的请求时对其它请求答忙、从不让出；较新的请求让先并写明原因，较早的完成', async (t) => {
  const { binding, paths } = await createRoot(t);
  const working = await openWindow(t, binding, 'working-window', { busy: WORK });
  const b = await openWindow(t, binding, 'window-b');
  // B: the user confirmed a migration there; it waits outside the locks for the working window.
  const migration = run(paths, {
    ...BASE, operation: 'data-root-migration', operationKey: 'to:/new-root', message: '为迁移数据目录', ignoreBackoff: true,
    whenBusy: 'wait', busyWaitTimeoutMs: 10_000, participantConfirmation: 'final-countdown', requesterHostBootId: 'window-b'
  }, async () => 'migrated');
  while ((await readExclusiveMaintenanceRequests(paths)).length === 0) await delay(10);
  // Any other request meanwhile: B's own window answers busy (a reload would drop its request).
  await writeRequest(paths, { requestId: 'later-request', createdAt: new Date(Date.now() + 1_000).toISOString(), whenBusy: 'abandon' });
  await b.check();
  const answer = await readAnswer(paths, 'later-request', 'window-b');
  assert.deepEqual([answer.answer, answer.busyKind, answer.reason], ['busy', 'work', '本窗口正在等待执行迁移数据目录']);
  await writeRequest(paths, { requestId: 'later-request', createdAt: new Date(Date.now() + 1_000).toISOString(), whenBusy: 'abandon', phase: 'confirm' });
  await b.check();
  assert.equal((await readAnswer(paths, 'later-request', 'window-b')).answer, 'busy', 'never confirms another request meanwhile');
  await fs.rm(path.join(runtimeExclusiveMaintenanceDirectory(paths), 'requests', 'later-request.json'));

  // D: the user clicks another operation in a second window: the later request gives way at once.
  const d = await openWindow(t, binding, 'window-d');
  const clicked = await run(paths, {
    ...BASE, operation: 'historical-merge', operationKey: 'source@x', message: '为合并较大的旧聊天记录', ignoreBackoff: true,
    whenBusy: 'wait', participantConfirmation: 'notice', requesterHostBootId: 'window-d'
  }, async () => assert.fail('must not run'));
  assert.equal(clicked.state, 'busy');
  assert.match(clicked.reason, /^另一个窗口先发起了迁移数据目录，这次让它先完成，没有进行；之后可以再试。$/);
  working.setBusy(undefined);
  assert.deepEqual(await migration, { state: 'completed', result: 'migrated', coordinated: true });
  assert.equal(b.releases(), 0, 'the window of the running request never yielded to another request');
  assert.deepEqual([working.releases(), d.releases()], [1, 1], 'the later requester yielded after its own request ended');
});

test('本窗口的请求让先于更早的请求：在对方确认前、倒计时之后与让出阶段都先不回答，本窗口请求结束后照常确认与让出', async (t) => {
  const { binding, paths } = await createRoot(t);
  let duringCountdown;
  // This window checks for requests only when the test says so.
  const b = await openWindow(t, binding, 'window-b', { pollMs: 60 * 60_000, confirm: (request) => { duringCountdown?.(request); return true; } });
  // B's own request (not published yet: B is alone and checks its own work first), finished on demand.
  const ownRequest = () => {
    let proceed;
    const gate = new Promise((resolve) => { proceed = resolve; });
    const done = run(paths, {
      ...BASE, operation: 'data-root-migration', operationKey: 'to:/other', message: '为迁移数据目录', ignoreBackoff: true,
      whenBusy: 'wait', requesterHostBootId: 'window-b', requesterBusy: () => gate
    }, async () => 'migrated');
    return { async finish() { proceed(undefined); assert.equal((await done).state, 'completed'); } };
  };
  const answer = (requestId) => readAnswer(paths, requestId, 'window-b').then((value) => [value.stage, value.answer]);

  // 1. B's own request starts before B saw the confirm of the earlier request.
  const first = { requestId: 'earlier-1', createdAt: '2020-01-01T00:00:00.000Z', whenBusy: 'wait', confirmation: 'notice' };
  await writeRequest(paths, first);
  await b.check();
  assert.deepEqual(await answer('earlier-1'), ['prepare', 'ready']);
  await writeRequest(paths, { ...first, phase: 'confirm' });
  let own = ownRequest();
  await b.check();
  assert.deepEqual(await answer('earlier-1'), ['prepare', 'ready'], 'no confirm (and no busy) while its own request runs');
  assert.equal(b.confirms(), 0);
  await own.finish();
  await b.check();
  assert.deepEqual(await answer('earlier-1'), ['confirm', 'confirmed']);

  // 2. B's own request starts while B counts down for the earlier request.
  const second = { ...first, requestId: 'earlier-2', createdAt: '2020-01-01T00:00:01.000Z' };
  await writeRequest(paths, second);
  await b.check();
  await writeRequest(paths, { ...second, phase: 'confirm' });
  duringCountdown = (request) => { if (request.requestId === 'earlier-2') own = ownRequest(); };
  await b.check();
  duringCountdown = undefined;
  assert.deepEqual(await answer('earlier-2'), ['prepare', 'ready'], 'no busy after the countdown either');
  await own.finish();
  await b.check();
  assert.deepEqual(await answer('earlier-2'), ['confirm', 'confirmed']);

  // 3. B's own request starts after B confirmed: at go B neither answers busy nor reloads until it ended.
  own = ownRequest();
  await writeRequest(paths, { ...second, phase: 'go' });
  await b.check();
  assert.deepEqual(await answer('earlier-2'), ['confirm', 'confirmed'], 'no busy answer at go');
  assert.equal(b.releases(), 0);
  await own.finish();
  await b.check();
  assert.equal(b.releases(), 1, 'yields to the earlier request once its own request ended');
});

test('本窗口的请求在发布请求文件之前就算“正在进行”：对别的请求答忙', async (t) => {
  const { binding, paths } = await createRoot(t);
  const b = await openWindow(t, binding, 'window-b', { pollMs: 60 * 60_000 });
  let proceed;
  const gate = new Promise((resolve) => { proceed = resolve; });
  const own = run(paths, {
    ...BASE, operation: 'data-root-migration', operationKey: 'to:/new', message: '为迁移数据目录', ignoreBackoff: true,
    whenBusy: 'wait', requesterHostBootId: 'window-b', requesterBusy: () => gate
  }, async () => 'migrated');
  assert.deepEqual(await readExclusiveMaintenanceRequests(paths), [], 'not published yet');
  await writeRequest(paths, { requestId: 'later-request', createdAt: new Date(Date.now() + 1_000).toISOString() });
  await b.check();
  const answer = await readAnswer(paths, 'later-request', 'window-b');
  assert.deepEqual([answer.answer, answer.reason], ['busy', '本窗口正在等待执行迁移数据目录']);
  proceed(undefined);
  assert.equal((await own).state, 'completed');
});

test('较新的请求让给已过 prepare 的较早自动请求（它持锁、窗口已确认）；不让给还在 prepare 的较早自动请求（它会自己放弃）', async (t) => {
  for (const phase of ['confirm', 'prepare']) {
    const { binding, paths } = await createRoot(t);
    const working = await openWindow(t, binding, 'working-window', { busy: WORK });
    const b = await openWindow(t, binding, 'window-b', { pollMs: 60 * 60_000 });
    const earlier = { requestId: 'earlier-automatic', createdAt: '2020-01-01T00:00:00.000Z', whenBusy: 'abandon', phase: 'prepare' };
    await writeRequest(paths, earlier);
    await b.check();
    await writeRequest(paths, { ...earlier, phase });
    if (phase === 'prepare') setTimeout(() => working.setBusy(undefined), 300);
    const own = await run(paths, {
      ...BASE, operation: 'data-root-migration', operationKey: 'to:/new', message: '为迁移数据目录', ignoreBackoff: true,
      whenBusy: 'wait', busyWaitTimeoutMs: 3_000, requesterHostBootId: 'window-b'
    }, async () => 'migrated');
    if (phase === 'confirm') {
      assert.equal(own.state, 'busy');
      assert.equal(own.gaveWayTo, 'earlier-automatic');
      assert.match(own.reason, /^另一个窗口先发起了整理数据，这次让它先完成/);
    } else {
      assert.deepEqual(own, { state: 'completed', result: 'migrated', coordinated: true }, 'both would give up otherwise');
    }
  }
});

test('两个请求的 createdAt 相同时按 requestId 定先后，不会两个都等', async (t) => {
  for (const [requestId, givesWay] of [['00000000-0000-4000-8000-000000000000', true], ['ffffffff-ffff-4fff-bfff-ffffffffffff', false]]) {
    const { binding, paths } = await createRoot(t);
    const working = await openWindow(t, binding, 'working-window', { busy: WORK });
    const outcome = run(paths, {
      ...BASE, operation: 'data-root-migration', operationKey: 'to:/new', message: '为迁移数据目录', ignoreBackoff: true,
      whenBusy: 'wait', busyWaitTimeoutMs: 1_500, requesterHostBootId: 'window-b'
    }, async () => 'migrated');
    let mine;
    while (!(mine = (await readExclusiveMaintenanceRequests(paths))[0])) await delay(5);
    // Another window's request published in the same millisecond.
    await writeRequest(paths, { requestId, createdAt: mine.createdAt, whenBusy: 'wait' });
    const result = await outcome;
    assert.equal(result.state, 'busy');
    if (givesWay) assert.equal(result.gaveWayTo, requestId);
    else assert.match(result.reason, /1 个其它窗口有任务正在进行/, 'the later of the two waits on');
    working.setBusy(undefined);
  }
});

test('beforeGo 自身抛错按本窗口忙处理：不发布 go、没有窗口重载，wait 模式回锁外，用完轮次后如实放弃', async (t) => {
  const { binding, paths } = await createRoot(t);
  const peer = await openWindow(t, binding, 'peer');
  let calls = 0;
  let lockedRounds = 0;
  let frozen = 0;
  // The Runtime of this window fails while it is checked (e.g. database is closed).
  const hasOwnedExecution = async () => { throw new Error('database is closed'); };
  const outcome = await run(paths, {
    ...BASE, whenBusy: 'wait', busyWaitTimeoutMs: 5_000, requesterHostBootId: 'self',
    // The documented shape: check first, then freeze and only do what cannot fail.
    beforeGo: async () => {
      calls += 1;
      const busy = await hasOwnedExecution();
      if (busy) return { busy: { kind: 'work', reason: '本窗口有任务正在进行' } };
      frozen += 1;
      return { thaw: () => { frozen -= 1; } };
    },
    withLocks: (body) => { lockedRounds += 1; return withRuntimeMaintenance(paths, body); }
  }, async () => assert.fail('must not run'));
  assert.equal(outcome.state, 'busy');
  assert.equal(outcome.reason, '准备期间反复有窗口变忙（最后一次：本窗口还有任务正在进行），这次没有进行，稍后再试。');
  assert.deepEqual([calls, lockedRounds, frozen], [3, 3, 0], 'never frozen: the check threw before the freeze');
  await settle([peer]);
  assert.equal(peer.releases(), 0);
  assert.deepEqual((await readExclusiveMaintenanceRequests(paths)).map((item) => item.phase), []);
});

test('没有发布 go 就不算已协调：其它窗口在 go 前全部关闭、本窗口最后一刻变忙时回锁外等待，原因如实', async (t) => {
  const { binding, paths } = await createRoot(t);
  const liveness = await publishHost(binding, 'closing-peer');
  const participant = startExclusiveMaintenanceParticipant(binding.paths, 'closing-peer', {
    busyReason: async () => undefined, confirm: async () => true, release: async () => {}
  }, { pollMs: 10, processId: (nextFakeProcessId += 1) });
  t.after(() => participant.dispose());
  await participant.checkNow();
  let heldCalls = 0;
  let lockedRounds = 0;
  const outcome = await run(paths, {
    ...BASE, whenBusy: 'wait', busyWaitTimeoutMs: 5_000, requesterHostBootId: 'self',
    // Busy at the last check of the first locked round only.
    requesterBusy: async () => {
      if (!isRuntimeMaintenanceHeld(paths)) return undefined;
      heldCalls += 1;
      return heldCalls === 2 ? { kind: 'work', reason: '本窗口有任务正在进行' } : undefined;
    },
    // The user closes the other window right after it answered ready.
    withLocks: async (body) => {
      lockedRounds += 1;
      await participant.dispose();
      await fs.rm(liveness, { force: true });
      return withRuntimeMaintenance(paths, body);
    }
  }, async () => 'done');
  assert.deepEqual(outcome, { state: 'completed', result: 'done', coordinated: true });
  assert.equal(lockedRounds, 2, 'went back outside instead of ending as if windows had reloaded');
});

test('排队等锁：等了 10 秒以上后锁释放，1.2 秒内拿到；换了持有者就重新快速轮询，排在后面的窗口紧跟着拿到，等待时长按当前持有者重新计算', async (t) => {
  const { root } = await createRoot(t);
  let letGo;
  const gate = new Promise((resolve) => { letGo = resolve; });
  let holding;
  const held = new Promise((resolve) => { holding = resolve; });
  const first = withRuntimeDataRootAdmission(root, async () => { holding(); await gate; });
  await held;
  const acquired = [];
  const waits = { a: [], b: [] };
  // Two windows queued behind a long maintenance; each opens for 1.5 s once it has the admission.
  const queued = ['a', 'b'].map((name) => new Promise((resolve) => setImmediate(resolve)).then(() =>
    withRuntimeDataRootAdmission(root, async () => {
      acquired.push({ name, at: performance.now() });
      await delay(1_500);
      acquired.at(-1).releasedAt = performance.now();
    }, { onWait: (wait) => waits[name].push(wait) })));
  await delay(10_800);
  const releasedAt = performance.now();
  letGo();
  await first;
  await Promise.all(queued);
  assert.ok(acquired[0].at - releasedAt <= 1_200, `first took ${acquired[0].at - releasedAt} ms after the release`);
  assert.ok(acquired[1].at - acquired[0].releasedAt <= 300, `second took ${acquired[1].at - acquired[0].releasedAt} ms after the first let go`);
  const second = acquired[1].name;
  const reported = waits[second];
  const beforeHandOver = reported.filter((wait) => wait.waitedMs < 10_500);
  const afterHandOver = reported.filter((wait) => wait.waitedMs > 11_000);
  assert.ok(beforeHandOver.at(-1).holderWaitedMs > 9_000);
  assert.ok(afterHandOver.length > 0 && afterHandOver.every((wait) => wait.holderWaitedMs < 2_000), 'measured from the new holder');
});

test('用户已确认的操作（不可取消倒计时或只提示）在确认阶段与倒计时之后只看任务不看焦点；普通倒计时仍看焦点', async (t) => {
  for (const confirmation of ['final-countdown', 'notice', 'countdown']) {
    const { binding, paths } = await createRoot(t);
    // The user clicks into the window whose countdown or notice just appeared, and stays there.
    let focused = false;
    const window = await openWindow(t, binding, `${confirmation}-window`, {
      busy: async () => focused ? { kind: 'focus', reason: '窗口正在使用' } : undefined,
      confirm: () => { focused = true; return true; }
    });
    let lockedRounds = 0;
    const outcome = await run(paths, {
      ...BASE, participantConfirmation: confirmation, whenBusy: 'wait', busyWaitTimeoutMs: 1_000,
      withLocks: (body) => { lockedRounds += 1; return withRuntimeMaintenance(paths, body); }
    }, async () => 'done');
    if (confirmation === 'countdown') {
      assert.equal(outcome.state, 'busy', 'an ordinary countdown still defers to the user in that window');
      assert.match(outcome.reason, /1 个其它窗口正在使用/);
      assert.equal(window.releases(), 0);
    } else {
      assert.deepEqual(outcome, { state: 'completed', result: 'done', coordinated: true }, confirmation);
      assert.equal(lockedRounds, 1, `${confirmation}: one round, not vetoed by focus`);
      assert.equal(window.releases(), 1);
    }
  }
});

test('锁内轮次用完时放弃原因按最后一次的实际原因：发起窗口自身任务、其它窗口任务分开写', async (t) => {
  const { binding, paths } = await createRoot(t);
  await openWindow(t, binding, 'idle-peer');
  let lockedRounds = 0;
  const outcome = await run(paths, {
    ...BASE, whenBusy: 'wait', requesterHostBootId: 'self',
    // The requester's own window is busy exactly while the locks are held (e.g. its Turn resumes).
    requesterBusy: async () => isRuntimeMaintenanceHeld(paths) ? { kind: 'work', reason: '本窗口有任务正在进行' } : undefined,
    withLocks: (body) => { lockedRounds += 1; return withRuntimeMaintenance(paths, body); }
  }, async () => assert.fail('must not run'));
  assert.equal(outcome.state, 'busy');
  assert.equal(lockedRounds, 3);
  assert.equal(outcome.reason, '准备期间反复有窗口变忙（最后一次：本窗口还有任务正在进行），这次没有进行，稍后再试。');
  assert.doesNotMatch(outcome.reason, /其它窗口/);
});

test('beforeGo 在全部确认之后、发布 go 之前调用：本窗口不空闲就在任何窗口重载前退回锁外或放弃；冻结在轮次结束时解除', async (t) => {
  const { binding, paths } = await createRoot(t);
  const log = [];
  const peer = await openWindow(t, binding, 'peer', { log });
  let checks = 0;
  const outcome = await run(paths, {
    ...BASE, whenBusy: 'wait', busyWaitTimeoutMs: 5_000, requesterHostBootId: 'self',
    beforeGo: async () => {
      checks += 1;
      const check = checks;
      log.push(['before-go', check]);
      const thaw = () => { log.push(['thaw', check]); };
      return check === 1 ? { busy: { kind: 'work', reason: '本窗口有任务正在进行' }, thaw } : { thaw };
    }
  }, async () => { log.push(['operation']); return 'done'; });
  assert.deepEqual(outcome, { state: 'completed', result: 'done', coordinated: true });
  const at = (entry) => log.findIndex((item) => JSON.stringify(item) === JSON.stringify(entry));
  const firstRelease = log.findIndex((item) => item[0] === 'release');
  const lastConfirm = log.findLastIndex((item) => item[0] === 'confirm');
  assert.ok(at(['before-go', 1]) > log.findIndex((item) => item[0] === 'confirm'), 'called after every window confirmed');
  assert.ok(at(['thaw', 1]) < at(['before-go', 2]) && at(['before-go', 2]) > lastConfirm, JSON.stringify(log));
  assert.ok(firstRelease > at(['before-go', 2]), 'nobody yielded before the requester froze and was idle');
  assert.ok(at(['operation']) < at(['thaw', 2]), 'thawed when the round ended');
  assert.equal(peer.releases(), 1);

  // Abandon mode: busy at beforeGo abandons before anybody yields.
  const { binding: other, paths: otherPaths } = await createRoot(t);
  const idle = await openWindow(t, other, 'idle');
  const abandoned = await run(otherPaths, {
    ...BASE, requesterHostBootId: 'self', beforeGo: async () => ({ busy: { kind: 'work', reason: '本窗口有任务正在进行' } })
  }, async () => assert.fail('must not run'));
  assert.equal(abandoned.state, 'busy');
  assert.match(abandoned.reason, /本窗口还有任务正在进行/);
  await settle([idle]);
  assert.equal(idle.releases(), 0);
});

test('让出阶段与执行前再查发起窗口自身：让出期间开始的任务让本次调用结束，操作不执行', async (t) => {
  const { binding, paths } = await createRoot(t);
  // The peer takes a while to reload, like a real window.
  await openWindow(t, binding, 'slow-peer', { releaseDelayMs: 2_000 });
  let ownWork = false;
  let checksWhileYielding = 0;
  let goAt;
  const outcome = await run(paths, {
    ...BASE, whenBusy: 'wait', busyWaitTimeoutMs: 5_000, requesterHostBootId: 'self',
    requesterBusy: async () => {
      if (ownWork) checksWhileYielding += 1;
      return ownWork ? { kind: 'work', reason: '本窗口有任务正在进行' } : undefined;
    },
    onProgress: (progress) => {
      if (progress.stage !== 'release' || ownWork) return;
      ownWork = true;
      goAt = performance.now();
    }
  }, async () => assert.fail('must not run'));
  assert.equal(outcome.state, 'busy');
  assert.match(outcome.reason, /^其它窗口开始让出后本窗口还有任务正在进行，这次没有进行/);
  assert.ok(checksWhileYielding >= 1);
  // Ended while the peer was still reloading, not only once everybody had gone.
  assert.ok(performance.now() - goAt < 1_000, `ended ${performance.now() - goAt} ms after the own work started`);

  // Alone (nobody to ask): the last check right before the operation.
  const { paths: alonePaths } = await createRoot(t);
  let calls = 0;
  const alone = await request(alonePaths, {
    ...BASE, requesterBusy: async () => ((calls += 1) >= 2 ? { kind: 'work', reason: '本窗口有任务正在进行' } : undefined)
  }, async () => assert.fail('must not run'));
  assert.equal(alone.state, 'busy');
  assert.equal(calls, 2, 'checked once before and once right before the operation');
});

test('锁内执行操作期间持续刷新请求与“维护进行中”标记：等待打开的窗口看到在做什么、已进行多久和阶段，轮询在最初几秒后退避', async (t) => {
  const { root, binding, paths } = await createRoot(t);
  await openWindow(t, binding, 'peer');
  const waits = [];
  let startOpening;
  const openingStarted = new Promise((resolve) => { startOpening = resolve; });
  // A reloaded window opening again: outside the requester's async scope, it waits on the admission.
  const opening = openingStarted.then(() => openUnderCurrentDataRootAdmission(async () => root, async () => 'opened', 5, {
    onWait: (wait) => waits.push(wait)
  }));
  let visible;
  const outcome = await run(paths, {
    ...BASE, operation: 'data-root-migration', operationKey: 'to:/new-root', message: '为迁移数据目录', ignoreBackoff: true,
    configurationRootPath: root, withLocks: (body) => withRuntimeDataRootAdmission(root, () => withRuntimeMaintenance(paths, body))
  }, async ({ reportStage }) => {
    startOpening();
    await delay(1_500);
    reportStage('正在复制正文（1/2）');
    await delay(3_500);
    // Before: the request was not refreshed while the operation ran (invisible after 15 s).
    visible = (await readExclusiveMaintenanceRequests(paths, { staleRequestMs: 3_000 })).map((item) => `${item.phase}:${item.activity}`);
    return 'migrated';
  });
  assert.equal(outcome.state, 'completed');
  assert.equal(await opening, 'opened', 'opens once the maintenance ended');
  assert.deepEqual(visible, ['go:迁移数据目录']);
  assert.ok(waits.length > 0 && waits[0].waitedMs >= RUNTIME_CLAIM_WAIT.reportAfterMs);
  assert.ok(waits.every((wait) => wait.activity?.description === '迁移数据目录' && wait.activity.operation === 'data-root-migration'));
  const last = waits.at(-1);
  assert.equal(last.activity.stage, '正在复制正文（1/2）');
  assert.equal(last.activity.stale, false);
  assert.ok(last.activity.heartbeatAgeMs < RUNTIME_CLAIM_WAIT.activityHeartbeatMs + 1_000, `heartbeat ${last.activity.heartbeatAgeMs} ms old`);
  assert.ok(last.activity.runningMs >= 4_500);
  const later = waits.filter((wait) => wait.waitedMs >= 3_000 && wait.waitedMs < 4_500).length;
  assert.ok(later >= 3 && later <= 8, `polls between 3 s and 4.5 s of waiting: ${later}`);
  await assert.rejects(fs.access(path.join(runtimeDataRootAdmissionClaimPath(root), 'activity.json')), 'gone with the claim');
});

test('持有方没有发布标记时只说在等其它窗口；标记属于别的持有方时不采用；心跳停止时报告没有进展，但从不越过锁', async (t) => {
  const { root } = await createRoot(t);
  await assert.rejects(withRuntimeMaintenanceActivity({ operation: 'x', description: '整理' }, async () => 1), /只能在持有/);
  let holding;
  const held = new Promise((resolve) => { holding = resolve; });
  let letGo;
  const gate = new Promise((resolve) => { letGo = resolve; });
  const holder = withRuntimeDataRootAdmission(root, async () => { holding(); await gate; });
  await held;
  const waits = [];
  const opening = new Promise((resolve) => setImmediate(resolve)).then(() =>
    openUnderCurrentDataRootAdmission(async () => root, async () => 'opened', 5, { onWait: (wait) => waits.push(wait) }));
  const claim = runtimeDataRootAdmissionClaimPath(root);
  const { claimToken } = JSON.parse(await fs.readFile(path.join(claim, 'owner.json'), 'utf8'));
  const marker = (token, heartbeatAt) => fs.writeFile(path.join(claim, 'activity.json'), JSON.stringify({
    kind: 'limcode-runtime-maintenance-activity', claimToken: token, operation: 'data-root-migration', description: '迁移数据目录',
    processId: process.pid, startedAt: new Date(Date.now() - 60_000).toISOString(), heartbeatAt
  }));
  await marker('another-holder', new Date().toISOString());
  await delay(1_300);
  assert.ok(waits.length > 0 && waits.every((wait) => wait.activity === undefined), 'another opening window, or a leftover');
  await marker(claimToken, new Date(Date.now() - 30_000).toISOString());
  const seen = waits.length;
  await delay(400);
  const stale = waits.slice(seen).find((wait) => wait.activity);
  assert.equal(stale?.activity.stale, true);
  assert.ok(stale.activity.heartbeatAgeMs >= 30_000);
  let opened = false;
  void opening.then(() => { opened = true; });
  await delay(200);
  assert.equal(opened, false, 'a stale holder is never taken over');
  letGo();
  await holder;
  assert.equal(await opening, 'opened');
});

test('残留清理与新请求交错：列完回应后再列一次请求，只删两次都没有请求且足够旧的回应，另一个请求方照常完成', async (t) => {
  const { binding, paths } = await createRoot(t);
  const peer = await openWindow(t, binding, 'peer');
  // R1's key backs off (an earlier abandoned attempt): below, R1 only sweeps and returns.
  peer.setBusy(WORK);
  assert.equal((await request(paths, { ...BASE, operationKey: 'k1', backoffBaseMs: 60_000 }, async () => 'x')).state, 'busy');
  peer.setBusy(undefined);
  await settle([peer]);
  const fsPromises = require('node:fs/promises');
  const original = fsPromises.readdir;
  const requestsDirectory = path.join(runtimeExclusiveMaintenanceDirectory(paths), 'requests');
  const responsesDirectory = path.join(runtimeExclusiveMaintenanceDirectory(paths), 'responses');
  let pauseNext = true;
  // R1's cleanup is paused between listing requests/ and listing responses/ (a slow platform probe,
  // heavy I/O), until another requester published and the peer answered it.
  fsPromises.readdir = async function patched(target, ...rest) {
    const result = await original.call(this, target, ...rest);
    if (pauseNext && path.resolve(String(target)) === requestsDirectory && /sweepAbandonedRequests/.test(new Error().stack)) {
      pauseNext = false;
      for (let i = 0; i < 300; i += 1) {
        if ((await original(responsesDirectory).catch(() => [])).length > 0) break;
        await delay(10);
      }
    }
    return result;
  };
  t.after(() => { fsPromises.readdir = original; });
  await fs.mkdir(requestsDirectory, { recursive: true });
  const r1 = run(paths, { ...BASE, operationKey: 'k1', backoffBaseMs: 60_000 }, async () => 'r1');
  await delay(30);
  const r2 = run(paths, { ...BASE, operationKey: 'k2', pollMs: 400, prepareTimeoutMs: 1_500 }, async () => 'r2');
  const [o1, o2] = await Promise.all([r1, r2]);
  fsPromises.readdir = original;
  // Before: R1 removed R2's fresh answers, the peer never answered again and R2 timed out.
  assert.equal(o2.state, 'completed', JSON.stringify(o2));
  assert.equal(o1.state, 'backoff');
  assert.equal(peer.releases(), 1, 'R2 made the peer yield');
});

/** The locked round alone, inside the target maintenance claim. */
async function request(paths, input, operation) {
  return withRuntimeMaintenance(paths, () => requestExclusiveRuntimeMaintenance(paths, { pollMs: 10, ...input }, operation));
}

/** Outside the locks: waits without locks, then the short locked round. */
async function run(paths, input, operation) {
  return runExclusiveRuntimeMaintenance(paths, {
    pollMs: 10, withLocks: (body) => withRuntimeMaintenance(paths, body), ...input
  }, operation);
}

/**
 * One simulated window: a Host liveness record plus the protocol participant. Yielding simulates the
 * reload: the participant stops and the liveness record disappears with the closed Runtime.
 */
async function openWindow(t, binding, hostBootId, options = {}) {
  const own = [];
  const push = (entry) => { own.push(entry); options.log?.push(entry); };
  let busy = options.busy;
  const liveness = await publishHost(binding, hostBootId, options.startedAt);
  if (options.registerAfterMs) await delay(options.registerAfterMs);
  let participant;
  let markReleased;
  const window = {
    log: own,
    released: new Promise((resolve) => { markReleased = resolve; }),
    setBusy(value) { busy = value; },
    confirms: () => own.filter((entry) => entry[0] === 'confirm').length,
    releases: () => own.filter((entry) => entry[0] === 'release').length,
    check: () => participant?.checkNow()
  };
  participant = startExclusiveMaintenanceParticipant(binding.paths, hostBootId, {
    busyReason: async (request) => typeof busy === 'function' ? busy(request) : busy,
    confirm: async (request) => {
      push(['confirm', hostBootId, request.round]);
      const answer = typeof options.confirm === 'function' ? options.confirm(request) : options.confirm;
      return (await answer) ?? true;
    },
    release: async (request) => {
      push(['release', hostBootId, request.round]);
      const closing = participant;
      participant = undefined;
      if (options.releaseDelayMs) await delay(options.releaseDelayMs);
      await closing.dispose();
      await fs.rm(liveness, { force: true });
      markReleased();
    },
    notifyWaiting: (_request, reason) => push(['waiting', hostBootId, reason.kind])
  }, { pollMs: options.pollMs ?? 10, processId: options.processId ?? (nextFakeProcessId += 1) });
  await participant.checkNow();
  t.after(async () => {
    await participant?.dispose();
    await fs.rm(liveness, { force: true });
  });
  return window;
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

async function readAnswer(paths, requestId, hostBootId) {
  return JSON.parse(await fs.readFile(path.join(runtimeExclusiveMaintenanceDirectory(paths), 'responses', requestId, `${hostBootId}.json`), 'utf8'));
}

/** Lets participants run a few more polls, so a late (wrong) reaction would show up. */
async function settle(windows) {
  await delay(60);
  for (const window of windows) await window.check();
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function exitedProcessId() {
  const child = spawn(process.execPath, ['-e', ''], { stdio: 'ignore' });
  await new Promise((resolve) => child.once('exit', resolve));
  return child.pid;
}

async function createRoot(t) {
  const parent = await fs.mkdtemp(path.join(os.tmpdir(), 'limcode-exclusive-maintenance-'));
  t.after(() => fs.rm(parent, { recursive: true, force: true }));
  const root = path.join(parent, 'global');
  await fs.mkdir(root);
  const authority = new RootAuthority(() => resolveVscodeRuntimeDataRoot({ globalStoragePath: root }));
  const binding = await kernel.initializeEmptyRuntimeRoot(authority);
  return { root, binding, paths: binding.paths };
}

async function publishHost(binding, hostBootId, startedAt = STARTED) {
  const target = path.join(binding.paths.dataRootPath, `host-liveness/${hostBootId}.json`);
  await fs.mkdir(path.dirname(target), { recursive: true });
  await fs.writeFile(target, JSON.stringify({ kind: 'limcode-runtime-host-liveness', dataSetId: binding.dataSetId, rootInstanceId: binding.rootInstanceId,
    rootGeneration: binding.rootGeneration, hostBootId, livenessId: `${hostBootId}-liveness`, processId: process.pid,
    processStartIdentity: ownProcessStartIdentity(), startedAt, heartbeatAt: NOW }));
  return target;
}
