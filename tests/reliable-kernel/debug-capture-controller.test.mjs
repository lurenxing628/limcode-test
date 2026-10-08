import assert from 'node:assert/strict';
import test from 'node:test';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { DebugCaptureController } = require('../../dist/extension/backend/reliableKernel/debugCapture/controller.js');
const { DEBUG_CAPTURE_LIMITS, normalizeDebugCaptureSettings } = require('../../dist/extension/shared/debugCapture.js');

function fixture(overrides = {}) {
  let wall = Date.parse('2026-09-07T00:00:00Z');
  let mark = 100;
  const runs = new Map();
  const timers = new Set();
  const counts = { validate: 0, inventory: 0, begin: 0, seal: 0, schedules: 0 };
  const ports = {
    ready: () => true,
    validate: async () => { counts.validate += 1; },
    inventory: async () => {
      counts.inventory += 1;
      return { runs: [...runs.values()], totalBytes: 0 };
    },
    begin: async (run) => { counts.begin += 1; runs.set(run.runId, structuredClone(run)); },
    rememberCommand: async (runId, commandId) => { runs.get(runId).commandAliases.push(commandId); },
    seal: async (run) => { counts.seal += 1; runs.set(run.runId, structuredClone(run)); },
    now: () => wall,
    monotonicNow: () => mark,
    schedule: (callback, delayMs) => {
      counts.schedules += 1;
      const timer = { callback, deadline: mark + delayMs };
      timers.add(timer);
      return () => timers.delete(timer);
    },
    source: { extensionVersion: 'test', sourceCommit: 'test', hostBootId: 'host-a', buildId: 'test-build' },
    ...overrides
  };
  const controller = new DebugCaptureController(ports);
  return {
    controller, ports, counts, runs, timers,
    start: (input = {}) => controller.start({ commandId: 'command-a', settings: normalizeDebugCaptureSettings(), conversationId: 'conversation-a', ...input }),
    wall: (value) => { wall = value; },
    advance: (milliseconds) => {
      mark += milliseconds;
      for (const timer of [...timers]) {
        if (timer.deadline > mark) continue;
        timers.delete(timer);
        timer.callback();
      }
    }
  };
}

const context = { conversationId: 'conversation-a', modelRequestId: 'request-a' };

test('默认关闭，不创建取证目录、不读盘、不创建定时器', async () => {
  const f = fixture();
  for (let i = 0; i < 100_000; i += 1) assert.equal(f.controller.accepts(context), false);
  assert.equal(f.controller.current(), undefined);
  await f.controller.close();
  assert.deepEqual(f.counts, { validate: 0, inventory: 0, begin: 0, seal: 0, schedules: 0 });
});

test('接收链路未就绪时拒绝开启，不把控制骨架冒充已完成取证', async () => {
  const f = fixture({ ready: () => false });
  await assert.rejects(f.start(), /尚未就绪/);
  assert.equal(f.counts.begin, 0);
  assert.equal(f.timers.size, 0);
});

test('重复开启只创建一份，并冻结对话目标与预算', async () => {
  const f = fixture();
  const settings = normalizeDebugCaptureSettings();
  const first = f.start({ settings });
  settings.scope = 'workspace';
  settings.maxMiB = 8;
  const [a, b] = await Promise.all([first, f.start()]);
  assert.equal(a.runId, b.runId);
  assert.equal(a.maxBytes, 32 * 1_048_576);
  assert.equal(a.target.scope, 'conversation');
  assert.match(a.runId, /^20260907-000000-000-model-stream-[a-f0-9]{8}$/);
  assert.equal(f.counts.begin, 1);
  assert.equal(f.timers.size, 1);
  assert.equal(f.controller.accepts(context), true);
  assert.equal(f.controller.accepts({ ...context, conversationId: 'conversation-b' }), false);
  a.target.conversationId = 'conversation-b';
  assert.equal(f.controller.accepts(context), true);
  await f.controller.close();
});

test('其他面板同目标开启复用活动记录，不扩大预算', async () => {
  const f = fixture();
  const a = await f.start({ settings: { scope: 'conversation', maxMiB: 8, maxMinutes: 5 } });
  const b = await f.start({ commandId: 'command-b' });
  assert.equal(a.runId, b.runId);
  assert.equal(b.maxBytes, 8 * 1_048_576);
  assert.equal(b.maxDurationMs, 5 * 60_000);
  await f.controller.close();
});

test('不同目标的并发开启不能暗中切换目标', async () => {
  const f = fixture();
  const [a, b] = await Promise.allSettled([f.start(), f.start({ commandId: 'command-b', conversationId: 'conversation-b' })]);
  assert.equal(a.status, 'fulfilled');
  assert.equal(b.status, 'rejected');
  assert.equal(f.counts.begin, 1);
  await assert.rejects(f.start({ conversationId: 'conversation-b' }), /同一开启命令/);
  await f.controller.close();
});

test('停止立即拒绝新记录，并且重复停止不重复写盘', async () => {
  const f = fixture();
  const a = await f.start();
  const stopping = f.controller.stop(a.runId);
  assert.equal(f.controller.accepts(context), false);
  assert.equal(f.controller.current().status, 'stopping');
  const stopped = await stopping;
  assert.equal(stopped.status, 'sealed');
  assert.deepEqual(await f.controller.stop(a.runId), stopped);
  assert.equal(f.counts.seal, 1);
  assert.equal(f.timers.size, 0);
  await f.controller.close();
});

test('旧面板停止旧记录不影响新活动；重发已结束的开启命令不会重新创建', async () => {
  const f = fixture();
  const a = await f.start();
  await f.controller.stop(a.runId);
  const b = await f.start({ commandId: 'command-b' });
  assert.equal((await f.controller.stop(a.runId)).status, 'sealed');
  assert.equal(f.controller.current().runId, b.runId);
  assert.equal(f.controller.accepts(context), true);
  assert.equal((await f.start()).runId, a.runId);
  assert.equal(f.counts.begin, 2);
  await f.controller.close();
});

test('以单调时钟执行时限，修改系统时间不能延长取证', async () => {
  const f = fixture();
  const a = await f.start({ settings: { scope: 'workspace', maxMiB: 16, maxMinutes: 5 } });
  f.wall(0);
  assert.equal(f.controller.accepts({ ...context, conversationId: 'conversation-b' }), true);
  f.advance(300_000);
  assert.equal(f.controller.accepts(context), false);
  await f.controller.stop(a.runId, 'time_limit');
  assert.equal(f.controller.current().stopReason, 'time_limit');
  assert.equal(f.controller.current().elapsedMs, 300_000);
});

test('累计容量与记录份数在创建文件之前检查，不删除旧记录', async () => {
  const f = fixture({ inventory: async () => ({ runs: [], totalBytes: DEBUG_CAPTURE_LIMITS.totalBytes - 32 * 1_048_576 + 1 }) });
  await assert.rejects(f.start(), /空间不足/);
  assert.equal(f.counts.begin, 0);
  const g = fixture({ inventory: async () => ({ runs: Array.from({ length: 16 }, (_, i) => ({ commandId: `old-${i}`, commandAliases: [] })), totalBytes: 0 }) });
  await assert.rejects(g.start(), /16 份/);
  assert.equal(g.counts.begin, 0);
  const h = fixture({ inventory: async () => ({ runs: [], totalBytes: DEBUG_CAPTURE_LIMITS.totalBytes - 32 * 1_048_576 }) });
  await h.start();
  assert.equal(h.counts.begin, 1);
  await h.controller.close();
});

test('文件创建失败不显示开启，不创建取证定时器', async () => {
  const f = fixture({ begin: async () => { throw new Error('磁盘满'); } });
  await assert.rejects(f.start(), /磁盘满/);
  assert.equal(f.controller.current(), undefined);
  assert.equal(f.controller.accepts(context), false);
  assert.equal(f.timers.size, 0);
});

test('绑定失效时不进入封存写入，不再接收记录，并公开失败原因', async () => {
  const f = fixture();
  const a = await f.start();
  f.ports.validate = async () => { throw new Error('数据目录绑定失效'); };
  await assert.rejects(f.controller.stop(a.runId), /绑定失效/);
  assert.equal(f.counts.seal, 0);
  assert.equal(f.controller.accepts(context), false);
  assert.equal(f.controller.current().hasGaps, true);
  assert.match(f.controller.failure(), /绑定失效/);
});

test('重启只读已有记录时仍保持关闭', async () => {
  const f = fixture();
  await f.start();
  await f.controller.close();
  const restarted = new DebugCaptureController(f.ports);
  assert.equal(restarted.current(), undefined);
  assert.equal(restarted.accepts(context), false);
  assert.equal(f.timers.size, 0);
  await restarted.close();
});

test('开启期间关闭宿主，文件创建返回后必须封存且不开始计时', async () => {
  const f = fixture();
  let release;
  let entered;
  const opening = new Promise((resolve) => { entered = resolve; });
  f.ports.begin = async (run) => {
    f.runs.set(run.runId, run);
    entered();
    await new Promise((resolve) => { release = resolve; });
  };
  const pending = f.start();
  await opening;
  const closing = f.controller.close();
  release();
  const run = await pending;
  await closing;
  assert.equal(run.status, 'sealed');
  assert.equal(run.stopReason, 'host_closed');
  assert.equal(f.timers.size, 0);
  await assert.rejects(f.start({ commandId: 'later' }), /已经关闭/);
});

test('设置转换只保留允许字段，不保存开启状态或继承任意容量', () => {
  assert.deepEqual(normalizeDebugCaptureSettings({ scope: 'workspace', maxMiB: Infinity, maxMinutes: 99, enabled: true }), {
    scope: 'workspace', maxMiB: 32, maxMinutes: 30
  });
});

test('另一面板的重复开启命令也保存对应关系，结束及重启后重发不创建新记录', async () => {
  const f = fixture();
  const a = await f.start();
  await f.start({ commandId: 'command-other-panel' });
  await f.controller.stop(a.runId);
  assert.equal((await f.start({ commandId: 'command-other-panel' })).runId, a.runId);
  assert.equal(f.counts.begin, 1);
  await f.controller.close();
  const restarted = new DebugCaptureController(f.ports);
  const previous = await restarted.start({ commandId: 'command-other-panel', conversationId: 'conversation-a', settings: normalizeDebugCaptureSettings() });
  assert.equal(previous.runId, a.runId);
  assert.equal(previous.status, 'sealed');
  assert.equal(restarted.current(), undefined);
  assert.equal(f.timers.size, 0);
});

test('开启命令对应关系保存失败时不谎报成功，也不改变活动目标', async () => {
  const f = fixture({ rememberCommand: async () => { throw new Error('写入失败'); } });
  const a = await f.start();
  await assert.rejects(f.start({ commandId: 'command-b' }), /写入失败/);
  assert.equal(f.controller.current().runId, a.runId);
  assert.deepEqual(f.controller.current().commandAliases, []);
  assert.equal(f.controller.accepts(context), true);
  await f.controller.close();
});
