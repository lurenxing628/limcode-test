import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fsSync from 'node:fs';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import vm from 'node:vm';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

/**
 * Multi-window exclusive maintenance end to end: the real VS Code layer (vscode/runtimeExclusiveMaintenance.ts)
 * in simulated windows, and real separate processes as windows. The scenarios the review reproduced
 * (windows reloading each other forever, idle windows reloaded in turn around a busy one, the
 * requester reloading itself) are asserted not to happen any more.
 */
const require = createRequire(import.meta.url);
const compiled = process.env.LIMCODE_TEST_EXTENSION_ROOT
  ? path.resolve(process.env.LIMCODE_TEST_EXTENSION_ROOT) : path.resolve('dist/extension');
const kernelFile = (file) => require(path.join(compiled, 'backend/reliableKernel', file));
const exclusive = kernelFile('runtimeExclusiveMaintenance.js');
const { readExclusiveMaintenanceRequest, requestExclusiveRuntimeMaintenance, startExclusiveMaintenanceParticipant } = exclusive;
const { withRuntimeMaintenance } = kernelFile('runtimeHostControl.js');
const { ownProcessStartIdentity } = kernelFile('runtimeClaimPrimitives.js');

const THIS_FILE = fileURLToPath(import.meta.url);
const WINDOW_PROCESS_ENV = 'LIMCODE_EXCLUSIVE_MAINTENANCE_WINDOW';
const NOW = '2026-09-26T00:00:00.000Z';
const STARTED = '2026-01-01T00:00:00.000Z';
const MERGE = { operation: 'historical-merge', operationKey: 'workspace:alpha', message: '为合并旧聊天记录', ignoreBackoff: false };
let nextFakeProcessId = 4_000_000;

if (process.env[WINDOW_PROCESS_ENV]) await runWindowProcess(JSON.parse(process.env[WINDOW_PROCESS_ENV]));
else defineTests();

function defineTests() {
  test('同一份待办每次启动都请求独占时，两个窗口不会互相重载：最多让出一次，之后进入冷却', async (t) => {
    const fixture = await createRoot(t);
    // Like a source that stays deferred: the operation never finishes the pending work.
    const sim = createWindowSimulator(t, fixture, { operation: async () => 'nothing-merged' });
    const a = sim.window('A');
    const b = sim.window('B');
    await sim.boot(a);
    void sim.boot(b);
    await delay(2_000);
    await sim.stop();
    assert.deepEqual(b.outcomes, ['coordinated']);
    assert.equal(a.outcomes[0], 'alone');
    assert.ok(['alone', 'backoff'].includes(a.outcomes[1]), JSON.stringify(a.outcomes));
    assert.equal(a.outcomes.length, 2);
    assert.deepEqual([a.reloads, b.reloads], [1, 0], 'before: both windows kept reloading each other');
  });

  test('待办永久失败（操作抛错）时同样不会互相重载', async (t) => {
    const fixture = await createRoot(t);
    const sim = createWindowSimulator(t, fixture, {
      operation: async () => { throw Object.assign(new Error('来源结构漂移'), { code: 'SCHEMA_DRIFT' }); }
    });
    const a = sim.window('A');
    const b = sim.window('B');
    await sim.boot(a);
    void sim.boot(b);
    await delay(2_000);
    await sim.stop();
    assert.deepEqual(b.outcomes, ['error']);
    assert.equal(a.outcomes.length, 2);
    assert.deepEqual([a.reloads, b.reloads], [1, 0]);
  });

  test('一个窗口长期有任务时，其余空闲窗口一个也不会被重载', async (t) => {
    const fixture = await createRoot(t);
    const sim = createWindowSimulator(t, fixture, { operation: async () => 'merged' });
    const busy = sim.window('B', { busy: true });
    const a = sim.window('A');
    const c = sim.window('C');
    await sim.open(busy);
    await sim.boot(a);
    await sim.boot(c);
    await delay(500);
    await sim.stop();
    assert.deepEqual(a.outcomes, ['busy']);
    assert.deepEqual(c.outcomes, ['backoff'], 'the same pending work is not retried at once');
    for (const window of [busy, a, c]) {
      assert.equal(window.reloads, 0, `${window.name} reloaded`);
      assert.deepEqual(window.countdowns(), [], `${window.name} showed a countdown`);
    }
  });

  test('聚焦（用户正在使用）的窗口回答忙，请求立即放弃，它不会倒计时', async (t) => {
    const fixture = await createRoot(t);
    const sim = createWindowSimulator(t, fixture, { operation: async () => 'merged' });
    const focused = sim.window('F', { focused: true });
    const requester = sim.window('R');
    await sim.open(focused);
    await sim.boot(requester);
    await sim.stop();
    assert.deepEqual(requester.outcomes, ['busy']);
    assert.match(requester.reasons[0], /窗口正在使用/);
    assert.deepEqual([focused.reloads, focused.countdowns().length], [0, 0]);
  });

  test('用户确认的迁移由运行中的窗口发起：自己不倒计时也不重载，其它窗口只提示、等忙窗口结束后统一重载', async (t) => {
    const fixture = await createRoot(t);
    const sim = createWindowSimulator(t, fixture, { bootRequests: false });
    const self = sim.window('self');
    const idle = sim.window('idle');
    const working = sim.window('working', { busy: true });
    for (const window of [self, idle, working]) await sim.open(window);
    setTimeout(() => { working.busy = false; }, 300);
    const outcome = await withRuntimeMaintenance(fixture.paths, () => sim.layer(self).runWithExclusiveMaintenance(fixture.paths, {
      operation: 'data-root-migration', operationKey: 'target:/new-root', message: '为迁移数据目录',
      requesterHostBootId: self.hostBootId, participantConfirmation: 'notice', whenBusy: 'wait', ignoreBackoff: true,
      waitingTitle: '正在等待其它窗口空闲后迁移数据目录', pollMs: 10, isCurrent: () => true
    }, async () => {
      // The requester closes its own Runtime here and reloads itself afterwards (the migration flow).
      assert.equal(idle.reloads + working.reloads, 2, 'every other window yielded before the operation');
      return 'migrated';
    }));
    await sim.stop();
    assert.deepEqual(outcome, { state: 'completed', result: 'migrated', coordinated: true });
    assert.deepEqual([self.reloads, self.countdowns().length, self.notices.length], [0, 0, 0]);
    assert.ok(self.titles.includes('正在等待其它窗口空闲后迁移数据目录'));
    for (const window of [idle, working]) {
      assert.equal(window.reloads, 1);
      assert.deepEqual(window.countdowns(), [], 'the user already confirmed: no countdown');
      assert.ok(window.notices.includes('为迁移数据目录，本窗口将重载；未发送的输入会保留。'), JSON.stringify(window.notices));
    }
    assert.deepEqual(working.notices.filter((notice) => /任务结束后会自动重载/.test(notice)),
      ['为迁移数据目录：本窗口的任务结束后会自动重载，未发送的输入会保留。'], 'told once, in advance');
    assert.deepEqual(idle.notices.filter((notice) => /任务结束后/.test(notice)), []);
  });

  test('多进程：两个空闲窗口都确认之后才统一让出（进程退出），全部下线后才执行', async (t) => {
    const fixture = await createRoot(t);
    const windows = [await spawnWindow(t, fixture, 'process-a'), await spawnWindow(t, fixture, 'process-b')];
    const outcome = await request(fixture.paths, MERGE, async () => {
      for (const window of windows) assert.notEqual((await window.exited).code, null);
      return 'merged';
    });
    assert.deepEqual(outcome, { state: 'completed', result: 'merged', coordinated: true });
    const confirms = windows.map((window) => window.at('confirm'));
    const releases = windows.map((window) => window.at('release'));
    assert.ok(confirms.every(Number.isFinite) && releases.every(Number.isFinite));
    assert.ok(Math.max(...confirms) <= Math.min(...releases), 'nobody yields before everybody confirmed');
    assert.equal(await readExclusiveMaintenanceRequest(fixture.paths), undefined);
  });

  test('多进程：有窗口在忙时立即放弃，没有任何进程让出', async (t) => {
    const fixture = await createRoot(t);
    const idle = await spawnWindow(t, fixture, 'process-idle');
    const busy = await spawnWindow(t, fixture, 'process-busy', { busy: '有任务正在进行' });
    const outcome = await request(fixture.paths, MERGE, async () => assert.fail('must not run'));
    assert.equal(outcome.state, 'busy');
    assert.deepEqual(outcome.hosts.map((host) => host.hostBootId), ['process-busy']);
    await delay(300);
    for (const window of [idle, busy]) {
      assert.equal(window.alive(), true);
      assert.deepEqual(window.events.filter((event) => ['confirm', 'release'].includes(event.event)), []);
    }
  });

  test('多进程：旧版本窗口（不参与协作）在场时立即放弃，不发布请求', async (t) => {
    const fixture = await createRoot(t);
    const idle = await spawnWindow(t, fixture, 'process-idle');
    const legacy = await spawnWindow(t, fixture, 'process-legacy', { legacy: true });
    const outcome = await request(fixture.paths, MERGE, async () => assert.fail('must not run'));
    assert.equal(outcome.state, 'legacy-host');
    assert.deepEqual(outcome.hosts.map((host) => host.hostBootId), ['process-legacy']);
    await delay(300);
    assert.deepEqual([idle.alive(), legacy.alive()], [true, true]);
    assert.deepEqual(idle.events.filter((event) => event.event !== 'ready'), []);
  });

  test('多进程：有窗口的用户选择保留时放弃，没有任何进程让出', async (t) => {
    const fixture = await createRoot(t);
    const keep = await spawnWindow(t, fixture, 'process-keep', { confirm: false });
    const other = await spawnWindow(t, fixture, 'process-other');
    const outcome = await request(fixture.paths, MERGE, async () => assert.fail('must not run'));
    assert.equal(outcome.state, 'declined');
    await delay(300);
    assert.deepEqual([keep.alive(), other.alive()], [true, true]);
    assert.ok(Number.isFinite(keep.at('confirm')));
    assert.equal(Number.isFinite(other.at('release')), false);
  });

  test('多进程：wait 模式提前提示忙窗口，等它结束工作后统一让出并执行', async (t) => {
    const fixture = await createRoot(t);
    const idle = await spawnWindow(t, fixture, 'process-idle');
    const working = await spawnWindow(t, fixture, 'process-working', { busy: '有任务正在进行', busyForMs: 1_500 });
    const outcome = await request(fixture.paths, {
      ...MERGE, whenBusy: 'wait', busyWaitTimeoutMs: 10_000, participantConfirmation: 'notice'
    }, async () => 'merged');
    assert.deepEqual(outcome, { state: 'completed', result: 'merged', coordinated: true });
    assert.equal(working.events.filter((event) => event.event === 'waiting').length, 1);
    assert.ok(working.at('waiting') < working.at('confirm'));
    for (const window of [idle, working]) assert.notEqual((await window.exited).code, null);
  });

  test('多进程：发起方进程崩溃后，残留请求不会让任何窗口让出，维护锁也能被接管', async (t) => {
    const fixture = await createRoot(t);
    const idle = await spawnWindow(t, fixture, 'process-idle');
    const busy = await spawnWindow(t, fixture, 'process-busy', { busy: '有任务正在进行' });
    const requester = await spawnWindow(t, fixture, 'process-requester', { requester: true });
    await requester.waitFor('requested');
    await delay(200);
    requester.child.kill('SIGKILL');
    await requester.exited;
    await delay(400);
    assert.equal(await readExclusiveMaintenanceRequest(fixture.paths), undefined, 'the crashed requester no longer counts');
    assert.deepEqual([idle.alive(), busy.alive()], [true, true]);
    assert.equal(Number.isFinite(idle.at('confirm')), false);
    // The dead requester's maintenance claim is taken over; the next request runs normally.
    const outcome = await request(fixture.paths, MERGE, async () => assert.fail('must not run'));
    assert.equal(outcome.state, 'busy');
  });
}

async function request(paths, input, operation) {
  return withRuntimeMaintenance(paths, () => requestExclusiveRuntimeMaintenance(paths, { pollMs: 20, ...input }, operation));
}

/**
 * Windows of the new version inside this process, each with the real VS Code layer. A reload closes
 * the Runtime (its liveness and participant registration disappear) and boots again; every boot may
 * run the startup fallback request for the same pending work first, exactly like a real startup.
 */
function createWindowSimulator(t, fixture, { operation, bootRequests = true }) {
  const state = { stopped: false, inflight: new Set() };
  const windows = [];
  const track = (promise) => {
    state.inflight.add(promise);
    void promise.finally(() => state.inflight.delete(promise));
    return promise;
  };
  const layer = (w) => loadVscodeLayer(vscodeMock(w, () => { void track(reload(w)); }));
  async function open(w) {
    w.hostBootId = `${w.name}-boot-${w.boots}`;
    // The Runtime opens under the maintenance claim; the participant starts right after.
    w.liveness = await withRuntimeMaintenance(fixture.paths, () => publishHost(fixture.binding, w.hostBootId, new Date().toISOString()));
    w.participant = layer(w).startExclusiveMaintenanceParticipant({
      exclusiveMaintenanceTarget: () => ({ paths: fixture.paths, hostBootId: w.hostBootId }),
      hasOwnedExecution: async () => w.busy === true
    }, { countdownSeconds: 0, pollMs: 15, processId: w.processId, isCurrent: () => !state.stopped });
  }
  async function boot(w) {
    if (state.stopped) return;
    w.boots += 1;
    if (bootRequests) {
      const outcome = await withRuntimeMaintenance(fixture.paths, () => layer(w).runWithExclusiveMaintenance(fixture.paths, {
        ...MERGE, waitingTitle: '正在等待其它窗口空闲后合并旧聊天记录', pollMs: 10, prepareTimeoutMs: 1_000,
        isCurrent: () => !state.stopped
      }, () => operation(w))).catch((error) => ({ state: 'error', reason: error.message }));
      w.outcomes.push(outcome.state === 'completed' ? (outcome.coordinated ? 'coordinated' : 'alone') : outcome.state);
      if (outcome.reason) w.reasons.push(outcome.reason);
    }
    if (state.stopped) return;
    await open(w);
  }
  async function reload(w) {
    if (state.stopped) return;
    w.reloads += 1;
    const participant = w.participant;
    w.participant = undefined;
    await participant?.dispose();
    await fs.rm(w.liveness, { force: true });
    await boot(w);
  }
  async function stop() {
    state.stopped = true;
    while (state.inflight.size) await Promise.allSettled([...state.inflight]);
    for (const w of windows) {
      await w.participant?.dispose();
      w.participant = undefined;
      if (w.liveness) await fs.rm(w.liveness, { force: true });
    }
  }
  t.after(stop);
  return {
    window(name, extra = {}) {
      const w = {
        name, boots: 0, reloads: 0, outcomes: [], reasons: [], titles: [], notices: [],
        processId: (nextFakeProcessId += 1),
        countdowns: () => w.titles.filter((title) => /本窗口即将重载/.test(title)),
        ...extra
      };
      windows.push(w);
      return w;
    },
    boot: (w) => track(boot(w)),
    open: (w) => track(open(w)),
    layer,
    stop
  };
}

function vscodeMock(w, onReload) {
  return {
    ProgressLocation: { Notification: 15 },
    window: {
      state: { get focused() { return w.focused === true; } },
      withProgress: async (options, task) => {
        w.titles.push(options.title);
        return task({ report() {} }, { isCancellationRequested: false, onCancellationRequested() {} });
      },
      showInformationMessage: async (message) => { w.notices.push(message); }
    },
    commands: {
      executeCommand: async (id) => {
        if (id === 'workbench.action.reloadWindow') setImmediate(onReload);
      }
    }
  };
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

/** A window as a separate process: it publishes its own liveness and answers with the real participant. */
async function spawnWindow(t, fixture, hostBootId, behavior = {}) {
  const env = { ...process.env };
  delete env.NODE_TEST_CONTEXT;
  env[WINDOW_PROCESS_ENV] = JSON.stringify({ binding: fixture.binding, hostBootId, behavior });
  const child = spawn(process.execPath, [THIS_FILE], { cwd: process.cwd(), env, stdio: ['ignore', 'pipe', 'inherit'] });
  const events = [];
  const listeners = new Set();
  let buffer = '';
  child.stdout.setEncoding('utf8');
  child.stdout.on('data', (chunk) => {
    buffer += chunk;
    let newline;
    while ((newline = buffer.indexOf('\n')) >= 0) {
      const line = buffer.slice(0, newline);
      buffer = buffer.slice(newline + 1);
      if (!line.startsWith('{')) continue;
      events.push(JSON.parse(line));
      for (const listener of listeners) listener();
    }
  });
  const exited = new Promise((resolve) => child.once('exit', (code, signal) => resolve({ code, signal })));
  t.after(async () => {
    if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
    await exited;
  });
  const window = {
    child,
    events,
    exited,
    alive: () => child.exitCode === null && child.signalCode === null,
    at: (name) => events.find((event) => event.event === name)?.at ?? Number.NaN,
    waitFor: (name, timeoutMs = 15_000) => new Promise((resolve, reject) => {
      const check = () => {
        const found = events.find((event) => event.event === name);
        if (!found) return;
        listeners.delete(check);
        clearTimeout(timer);
        resolve(found);
      };
      const timer = setTimeout(() => {
        listeners.delete(check);
        reject(new Error(`${hostBootId} did not report ${name}: ${JSON.stringify(events)}`));
      }, timeoutMs);
      listeners.add(check);
      check();
    })
  };
  await window.waitFor('ready');
  return window;
}

async function runWindowProcess({ binding, hostBootId, behavior }) {
  const emit = (event, extra = {}) => new Promise((resolve) => {
    process.stdout.write(`${JSON.stringify({ event, at: Date.now(), ...extra })}\n`, resolve);
  });
  const startedAt = Date.now();
  setInterval(() => {}, 60_000);
  if (behavior.requester) {
    emit('ready');
    await withRuntimeMaintenance(binding.paths, () => requestExclusiveRuntimeMaintenance(binding.paths, {
      ...MERGE, whenBusy: 'wait', busyWaitTimeoutMs: 60_000, pollMs: 20, onWaitStart: () => emit('requested')
    }, async () => emit('operation')));
    return;
  }
  // A window that ran for a while: a missing registration means an older version.
  await publishHost(binding, hostBootId, STARTED, process.pid);
  if (behavior.legacy) {
    emit('ready');
    return;
  }
  const participant = startExclusiveMaintenanceParticipant(binding.paths, hostBootId, {
    busyReason: async () => behavior.busy && (!behavior.busyForMs || Date.now() - startedAt < behavior.busyForMs)
      ? behavior.busy : undefined,
    confirm: async () => {
      await emit('confirm');
      return behavior.confirm ?? true;
    },
    release: async () => {
      await emit('release');
      // A reload replaces the Extension Host process; its liveness record stays behind, proven dead.
      process.exit(0);
    },
    notifyWaiting: (_request, reason) => emit('waiting', { reason })
  }, { pollMs: 20, onError: (error) => emit('error', { message: String(error?.message ?? error) }) });
  await participant.checkNow();
  emit('ready');
}

async function createRoot(t) {
  const kernel = kernelFile('index.js');
  const { RootAuthority } = kernelFile('rootAuthority.js');
  const { resolveVscodeRuntimeDataRoot } = kernelFile('vscodeRootAuthority.js');
  const parent = await fs.mkdtemp(path.join(os.tmpdir(), 'limcode-exclusive-windows-'));
  t.after(() => fs.rm(parent, { recursive: true, force: true }));
  const root = path.join(parent, 'global');
  await fs.mkdir(root);
  const authority = new RootAuthority(() => resolveVscodeRuntimeDataRoot({ globalStoragePath: root }));
  const binding = await kernel.initializeEmptyRuntimeRoot(authority);
  return { root, binding, paths: binding.paths };
}

async function publishHost(binding, hostBootId, startedAt = STARTED, processId = process.pid) {
  const target = path.join(binding.paths.dataRootPath, `host-liveness/${hostBootId}.json`);
  await fs.mkdir(path.dirname(target), { recursive: true });
  await fs.writeFile(target, JSON.stringify({ kind: 'limcode-runtime-host-liveness', dataSetId: binding.dataSetId, rootInstanceId: binding.rootInstanceId,
    rootGeneration: binding.rootGeneration, hostBootId, livenessId: `${hostBootId}-liveness`, processId,
    processStartIdentity: ownProcessStartIdentity(), startedAt, heartbeatAt: NOW }));
  return target;
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
