import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fsSync from 'node:fs';
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
  isRuntimeDataRootAdmissionHeld, openUnderCurrentDataRootAdmission, withRuntimeDataRootAdmission, withRuntimeMaintenance
} = kernelFile('runtimeHostControl.js');
const {
  readExclusiveMaintenanceRequest, registerExclusiveMaintenanceParticipant, requestExclusiveRuntimeMaintenance,
  runtimeExclusiveMaintenanceDirectory, startExclusiveMaintenanceParticipant
} = kernelFile('runtimeExclusiveMaintenance.js');
const { VscodeReliableKernelApplicationFacade: Facade } = require(path.join(
  compiled, 'backend/application/reliableKernel/VscodeReliableKernelApplicationFacade.js'
));

const NOW = '2026-09-26T00:00:00.000Z';
// Long-running windows; a window that started moments ago gets a short grace to register.
const STARTED = '2026-01-01T00:00:00.000Z';
const BASE = { operation: 'historical-merge', operationKey: 'sources-a', message: '为合并旧聊天记录' };
// Several simulated windows share this process: each gets its own identity for the self check.
let nextFakeProcessId = 3_000_000;

test('只能在 maintenance（及给定的 admission）内发起；没有其它窗口时直接执行，不发布请求', async (t) => {
  const { root, paths } = await createRoot(t);
  await assert.rejects(requestExclusiveRuntimeMaintenance(paths, BASE, async () => 1), /maintenance 锁内/);
  await assert.rejects(withRuntimeMaintenance(paths, () => requestExclusiveRuntimeMaintenance(
    paths, { ...BASE, configurationRootPath: root }, async () => 1
  )), /admission 内/);
  let waits = 0;
  const outcome = await request(paths, { ...BASE, onWaitStart: () => { waits += 1; } }, async () => 'done');
  assert.deepEqual(outcome, { state: 'completed', result: 'done', coordinated: false });
  assert.equal(waits, 0);
  assert.equal(await readExclusiveMaintenanceRequest(paths), undefined);
  const nested = await withRuntimeDataRootAdmission(root, () => request(
    paths, { ...BASE, configurationRootPath: root }, async () => 'nested'
  ));
  assert.deepEqual(nested, { state: 'completed', result: 'nested', coordinated: false });
});

test('有未参与协作（旧版本）或状态无法确认的窗口时立即放弃，不发布请求，同一操作键随后退避', async (t) => {
  const { binding, paths } = await createRoot(t);
  await publishHost(binding, 'old-window');
  let ran = false;
  const run = async () => { ran = true; };
  const first = await request(paths, BASE, run);
  assert.equal(first.state, 'legacy-host');
  assert.deepEqual(first.hosts.map((host) => host.hostBootId), ['old-window']);
  assert.match(first.reason, /未参与协作的窗口（可能是旧版本）/);
  assert.equal(await readExclusiveMaintenanceRequest(paths), undefined);

  const second = await request(paths, BASE, run);
  assert.equal(second.state, 'backoff');
  assert.ok(Date.parse(second.retryAfter) > Date.now());
  assert.equal((await request(paths, { ...BASE, operationKey: 'sources-b' }, run)).state, 'legacy-host',
    'a different work is not delayed by this key');
  assert.equal((await request(paths, { ...BASE, ignoreBackoff: true }, run)).state, 'legacy-host',
    'an explicit user request ignores the backoff');

  await fs.writeFile(path.join(paths.dataRootPath, 'host-liveness', 'broken.json'), '{');
  const unknown = await request(paths, { ...BASE, operationKey: 'sources-c' }, run);
  assert.equal(unknown.state, 'legacy-host');
  assert.match(unknown.reason, /运行状态无法确认/);
  assert.equal(ran, false);
});

test('刚启动、尚未登记的窗口有短暂宽限：登记后正常回应，不被当成旧版本', async (t) => {
  const { binding, paths } = await createRoot(t);
  const opening = openWindow(t, binding, 'just-opened', { startedAt: new Date().toISOString(), registerAfterMs: 150 });
  // The request is issued while the window's Runtime is open but its participant not started yet.
  await new Promise((resolve) => setTimeout(resolve, 50));
  const outcome = await request(paths, BASE, async () => 'done');
  const window = await opening;
  assert.deepEqual(outcome, { state: 'completed', result: 'done', coordinated: true });
  assert.equal(window.releases(), 1);
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
    assert.equal((await readExclusiveMaintenanceRequest(paths))?.phase, 'go');
    return 42;
  });
  assert.deepEqual(outcome, { state: 'completed', result: 42, coordinated: true });
  assert.deepEqual(log[0], ['wait-start', ['window-a', 'window-b']]);
  const lastConfirm = Math.max(...['window-a', 'window-b'].map((name) => log.findLastIndex((entry) => entry[0] === 'confirm' && entry[1] === name)));
  const firstRelease = log.findIndex((entry) => entry[0] === 'release');
  assert.ok(lastConfirm >= 0 && firstRelease > lastConfirm, `every window confirms before any yields: ${JSON.stringify(log)}`);
  assert.deepEqual(log.slice(-2), [['wait-end'], ['operation']]);
  assert.equal(a.releases(), 1);
  assert.equal(b.releases(), 1);
  assert.equal(await readExclusiveMaintenanceRequest(paths), undefined);
  const directory = runtimeExclusiveMaintenanceDirectory(paths);
  assert.equal(fsSync.existsSync(path.join(directory, 'request.json')), false);
  assert.deepEqual(await fs.readdir(path.join(directory, 'responses')), []);
});

test('有窗口在忙时立即放弃：没有任何窗口倒计时或重载，同一操作键随后退避', async (t) => {
  const { binding, paths } = await createRoot(t);
  const idle = await openWindow(t, binding, 'idle-window');
  const busy = await openWindow(t, binding, 'busy-window', { busy: '有任务正在进行' });
  let ran = false;
  const outcome = await request(paths, BASE, async () => { ran = true; });
  assert.equal(outcome.state, 'busy');
  assert.deepEqual(outcome.hosts.map((host) => host.hostBootId), ['busy-window']);
  assert.match(outcome.reason, /其它窗口正在忙（有任务正在进行）/);
  await settle([idle, busy]);
  assert.deepEqual([idle.confirms(), idle.releases(), busy.confirms(), busy.releases()], [0, 0, 0, 0]);
  assert.equal(ran, false);
  assert.equal(await readExclusiveMaintenanceRequest(paths), undefined);
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

test('wait 模式：等忙窗口空闲后再协调，只提示它一次；等待有上限', async (t) => {
  const { binding, paths } = await createRoot(t);
  const idle = await openWindow(t, binding, 'idle-window');
  const busy = await openWindow(t, binding, 'busy-window', { busy: '有任务正在进行' });
  setTimeout(() => busy.setBusy(undefined), 200);
  const stages = [];
  const outcome = await request(paths, {
    ...BASE, operation: 'data-root-migration', operationKey: 'target-1', message: '为迁移数据目录',
    whenBusy: 'wait', participantConfirmation: 'notice', busyWaitTimeoutMs: 5_000,
    onProgress: (progress) => stages.push(progress.stage)
  }, async () => 'migrated');
  assert.deepEqual(outcome, { state: 'completed', result: 'migrated', coordinated: true });
  assert.ok(stages.includes('waiting-busy'));
  assert.deepEqual(busy.log.filter((entry) => entry[0] === 'waiting'), [['waiting', 'busy-window', '有任务正在进行']]);
  assert.deepEqual([idle.releases(), busy.releases()], [1, 1]);

  const { binding: other, paths: otherPaths } = await createRoot(t);
  const stuck = await openWindow(t, other, 'stuck-window', { busy: '有任务正在进行' });
  const started = performance.now();
  const bounded = await request(otherPaths, {
    ...BASE, whenBusy: 'wait', busyWaitTimeoutMs: 200
  }, async () => assert.fail('must not run'));
  assert.equal(bounded.state, 'busy');
  assert.ok(performance.now() - started < 3_000);
  await settle([stuck]);
  assert.equal(stuck.releases(), 0);
});

test('wait 模式下确认后又开始工作的窗口不会被打断：回到准备阶段重新一轮', async (t) => {
  const { binding, paths } = await createRoot(t);
  const steady = await openWindow(t, binding, 'steady-window');
  const flaky = await openWindow(t, binding, 'flaky-window', {
    confirm: (request) => {
      if (request.round === 1) {
        // The user started a Turn while the countdown ran.
        flaky.setBusy('有任务正在进行');
        setTimeout(() => flaky.setBusy(undefined), 150);
      }
      return true;
    }
  });
  const outcome = await request(paths, { ...BASE, whenBusy: 'wait', busyWaitTimeoutMs: 5_000 }, async () => 'done');
  assert.deepEqual(outcome, { state: 'completed', result: 'done', coordinated: true });
  assert.deepEqual(flaky.log.filter((entry) => entry[0] === 'release').map((entry) => entry[2]), [2]);
  assert.deepEqual(steady.log.filter((entry) => entry[0] === 'release').map((entry) => entry[2]), [2]);
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
  assert.equal(await readExclusiveMaintenanceRequest(paths), undefined);

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
  // B opened; A restarts and would ask B for the same operation (even another key): cooldown.
  const b = await openWindow(t, binding, 'window-b');
  const reverse = await request(paths, { ...BASE, operationKey: 'sources-b' }, async () => assert.fail('must not run'));
  assert.equal(reverse.state, 'backoff');
  assert.match(reverse.reason, /刚刚已经让其它窗口重载过一次/);
  await settle([b]);
  assert.equal(b.confirms(), 0);
  // The user explicitly asking is the exception.
  const explicit = await request(paths, { ...BASE, operationKey: 'sources-b', ignoreBackoff: true }, async () => 'explicit');
  assert.equal(explicit.state, 'completed');
  assert.equal(b.releases(), 1);
});

test('清理失败不会覆盖已完成的结果；EPERM 等临时错误会重试', async (t) => {
  const { binding, paths } = await createRoot(t);
  const directory = runtimeExclusiveMaintenanceDirectory(paths);
  const fsPromises = require('node:fs/promises');
  const originalRm = fsPromises.rm;
  let transient = 0;
  fsPromises.rm = async (target, options) => {
    if (String(target) === path.join(directory, 'request.json') && transient < 2) {
      transient += 1;
      throw Object.assign(new Error('operation not permitted'), { code: 'EPERM' });
    }
    return originalRm(target, options);
  };
  t.after(() => { fsPromises.rm = originalRm; });
  await openWindow(t, binding, 'window-a');
  assert.deepEqual(await request(paths, BASE, async () => 'first'), { state: 'completed', result: 'first', coordinated: true });
  assert.equal(transient, 2);
  assert.equal(fsSync.existsSync(path.join(directory, 'request.json')), false, 'removed after retrying');
  fsPromises.rm = originalRm;

  if (process.platform === 'win32' || process.getuid?.() === 0) return;
  await openWindow(t, binding, 'window-b');
  const warnings = [];
  const originalWarn = console.warn;
  console.warn = (...args) => warnings.push(String(args[0]));
  t.after(() => { console.warn = originalWarn; });
  const outcome = await request(paths, { ...BASE, operationKey: 'sources-b', ignoreBackoff: true }, async () => {
    await fs.chmod(directory, 0o500);
    return 'second';
  });
  await fs.chmod(directory, 0o700);
  console.warn = originalWarn;
  assert.deepEqual(outcome, { state: 'completed', result: 'second', coordinated: true });
  assert.ok(warnings.some((warning) => /无法撤回独占维护请求/.test(warning)), JSON.stringify(warnings));
});

test('轮询期间每个进程只做一次平台身份探测，之后只用 kill(pid, 0) 复查', async (t) => {
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
  processProtocol.readProcessStartFingerprint = original;
  assert.equal(outcome.state, 'timed-out');
  // Before: every poll re-probed every Host (about 5 polls x 2 Hosts within this second).
  assert.ok(probes <= 1, `probes=${probes}`);

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

test('过期请求或请求方进程已不存在的请求不会被理会；死进程的参与登记会被清理', async (t) => {
  const { paths } = await createRoot(t);
  const directory = runtimeExclusiveMaintenanceDirectory(paths);
  await fs.mkdir(path.join(directory, 'hosts'), { recursive: true });
  const valid = {
    kind: 'limcode-runtime-exclusive-maintenance-request', requestId: 'request-1', round: 1, phase: 'prepare',
    operation: 'historical-merge', operationKey: 'sources-a', message: '为合并旧聊天记录', confirmation: 'countdown',
    whenBusy: 'abandon', requesterProcessId: process.pid, requesterProcessStartIdentity: ownProcessStartIdentity(),
    createdAt: NOW, expiresAt: new Date(Date.now() + 60_000).toISOString()
  };
  const write = (value) => fs.writeFile(path.join(directory, 'request.json'), JSON.stringify(value));
  await write(valid);
  assert.equal((await readExclusiveMaintenanceRequest(paths))?.requestId, 'request-1');
  await write({ ...valid, expiresAt: NOW });
  assert.equal(await readExclusiveMaintenanceRequest(paths), undefined);
  const { round: _round, ...withoutRound } = valid;
  await write(withoutRound);
  assert.equal(await readExclusiveMaintenanceRequest(paths), undefined, 'an older request format is not trusted');
  const deadProcessId = await exitedProcessId();
  await write({ ...valid, requesterProcessId: deadProcessId, requesterProcessStartIdentity: undefined });
  assert.equal(await readExclusiveMaintenanceRequest(paths), undefined);
  if (ownProcessStartIdentity() !== undefined) {
    await write({ ...valid, requesterProcessStartIdentity: 'another-process-start' });
    assert.equal(await readExclusiveMaintenanceRequest(paths), undefined);
    await fs.writeFile(path.join(directory, 'hosts', 'stale-window.json'), JSON.stringify({
      kind: 'limcode-runtime-exclusive-maintenance-participant', hostBootId: 'stale-window',
      processId: process.pid, processStartIdentity: 'another-process-start', registeredAt: NOW
    }));
    const participant = await registerExclusiveMaintenanceParticipant(paths, 'fresh-window');
    assert.deepEqual(await fs.readdir(path.join(directory, 'hosts')), ['fresh-window.json']);
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
  await new Promise((resolve) => setTimeout(resolve, 100));
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

async function request(paths, input, operation) {
  return withRuntimeMaintenance(paths, () => requestExclusiveRuntimeMaintenance(paths, { pollMs: 10, ...input }, operation));
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
  if (options.registerAfterMs) await new Promise((resolve) => setTimeout(resolve, options.registerAfterMs));
  let participant;
  const window = {
    log: own,
    setBusy(value) { busy = value; },
    confirms: () => own.filter((entry) => entry[0] === 'confirm').length,
    releases: () => own.filter((entry) => entry[0] === 'release').length,
    check: () => participant?.checkNow()
  };
  participant = startExclusiveMaintenanceParticipant(binding.paths, hostBootId, {
    busyReason: async () => busy,
    confirm: async (request) => {
      push(['confirm', hostBootId, request.round]);
      const answer = typeof options.confirm === 'function' ? options.confirm(request) : options.confirm;
      return answer ?? true;
    },
    release: async (request) => {
      push(['release', hostBootId, request.round]);
      const closing = participant;
      participant = undefined;
      await closing.dispose();
      await fs.rm(liveness, { force: true });
    },
    notifyWaiting: (_request, reason) => push(['waiting', hostBootId, reason])
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
  await new Promise((resolve) => setTimeout(resolve, 60));
  for (const window of windows) await window.check();
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
