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
  isRuntimeDataRootAdmissionHeld, isRuntimeMaintenanceHeld, openUnderCurrentDataRootAdmission,
  withRuntimeDataRootAdmission, withRuntimeMaintenance
} = kernelFile('runtimeHostControl.js');
const {
  readExclusiveMaintenanceRequests, registerExclusiveMaintenanceParticipant, requestExclusiveRuntimeMaintenance,
  runExclusiveRuntimeMaintenance, runtimeExclusiveMaintenanceDirectory, startExclusiveMaintenanceParticipant
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
  assert.match(outcome.reason, /反复/);
  assert.equal(lockedRounds, 2);
  assert.equal(window.releases(), 0);
});

test('go 阶段回答忙的窗口本轮不再重载（即使随后变空闲）；已让出的窗口白白重载，操作不执行', async (t) => {
  const { binding, paths } = await createRoot(t);
  const fast = await openWindow(t, binding, 'fast-window');
  let answeredGoBusy = false;
  const slow = await openWindow(t, binding, 'slow-window', {
    // The user clicks into this window after it confirmed, right before it saw go, then leaves.
    busy: async (request) => {
      if (request.phase !== 'go' || answeredGoBusy) return undefined;
      answeredGoBusy = true;
      return { kind: 'focus', reason: '窗口正在使用' };
    }
  });
  let ran = false;
  // The requester reads the busy answer only on its next poll; meanwhile the window is idle again
  // and still sees go: it must not reload in this round.
  const outcome = await request(paths, { ...BASE, pollMs: 300 }, async () => { ran = true; });
  assert.equal(outcome.state, 'busy');
  assert.equal(ran, false);
  await settle([slow, fast]);
  await delay(100);
  await slow.check();
  assert.equal(slow.releases(), 0, 'a window that answered busy at go never yields in that round');
  assert.equal(fast.releases(), 1, 'the documented cost of a go-stage abandon');
});

test('go 之后操作失败按操作键退避（冷却不可跳过）；确定性失败直接转 blocked；成功后退避清零', async (t) => {
  const { binding, paths } = await createRoot(t);
  const failure = () => Object.assign(new Error('复制正文文件时出错'), { code: 'EIO' });
  const cooldownAfterCoordinatedMs = 1_000;
  const input = { ...BASE, cooldownAfterCoordinatedMs, backoffBaseMs: 60_000 };
  await openWindow(t, binding, 'peer-1');
  await assert.rejects(request(paths, input, async () => { throw failure(); }), /复制正文文件时出错/);
  await openWindow(t, binding, 'peer-2');
  const again = await request(paths, input, async () => assert.fail('must not run'));
  assert.equal(again.state, 'backoff', 'the failed work backs off like an abandoned attempt');
  const explicit = await request(paths, { ...input, ignoreBackoff: true }, async () => assert.fail('must not run'));
  assert.equal(explicit.state, 'backoff', 'an explicit request skips the key backoff, never the cooldown');
  assert.match(explicit.reason, /刚刚已经让其它窗口重载过/);
  await delay(cooldownAfterCoordinatedMs + 50);
  const ledger = path.join(runtimeExclusiveMaintenanceDirectory(paths), 'ledger');
  const keyEntry = async () => {
    for (const name of await fs.readdir(ledger)) {
      const entry = JSON.parse(await fs.readFile(path.join(ledger, name), 'utf8'));
      if (entry.scope === 'key') return entry;
    }
    return undefined;
  };
  assert.equal((await keyEntry()).attempts, 1);
  assert.deepEqual(await request(paths, { ...input, ignoreBackoff: true }, async () => 'merged'),
    { state: 'completed', result: 'merged', coordinated: true });
  assert.equal(await keyEntry(), undefined, 'success resets the backoff');

  // A deterministic failure blocks the key for good, whoever asks and even with no other window.
  const deterministic = { ...BASE, operationKey: 'drifted-source', isDeterministicFailure: (error) => error.code === 'SCHEMA_DRIFT' };
  await assert.rejects(request(paths, deterministic, async () => {
    throw Object.assign(new Error('来源结构漂移'), { code: 'SCHEMA_DRIFT' });
  }), /来源结构漂移/);
  const blocked = await request(paths, { ...deterministic, ignoreBackoff: true }, async () => assert.fail('must not run'));
  assert.equal(blocked.state, 'blocked');
  assert.match(blocked.reason, /来源结构漂移/);
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
  for (const ignoreBackoff of [false, true]) {
    const reverse = await request(paths, { ...BASE, operationKey: 'sources-b', ignoreBackoff }, async () => assert.fail('must not run'));
    assert.equal(reverse.state, 'backoff');
    assert.match(reverse.reason, /刚刚已经让其它窗口重载过一次/);
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
    operation: 'historical-merge', operationKey: 'sources-a', message: '为合并旧聊天记录', confirmation: 'countdown',
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
  await request(paths, BASE, async () => 'done');
  assert.deepEqual(await fs.readdir(path.join(directory, 'requests')), []);
  assert.deepEqual(await fs.readdir(path.join(directory, 'responses')), []);

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
  const window = {
    log: own,
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
      await closing.dispose();
      await fs.rm(liveness, { force: true });
    },
    notifyWaiting: (_request, reason) => push(['waiting', hostBootId, reason.kind])
  }, { pollMs: 10, processId: options.processId ?? (nextFakeProcessId += 1) });
  await participant.checkNow();
  t.after(async () => {
    await participant?.dispose();
    await fs.rm(liveness, { force: true });
  });
  return window;
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
